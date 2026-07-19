import { describe, expect, it, vi } from 'vitest';

// Shared recorder for the mssql driver mock (hoisted so it exists before the mock factory runs).
const rec = vi.hoisted(() => ({
  events: [] as string[],
  queries: [] as { sql: string; inputs: Record<string, unknown>; requestTimeout?: number }[],
  batches: [] as { sql: string; inputs: Record<string, unknown>; requestTimeout?: number }[],
  failOn: undefined as string | undefined,
  failConnectOnce: false,
  failShowplanOff: false,
  reset(failOn?: string) {
    this.events = [];
    this.queries = [];
    this.batches = [];
    this.failOn = failOn;
    this.failConnectOnce = false;
    this.failShowplanOff = false;
  },
}));

vi.mock('mssql', () => {
  class FakeRequest {
    inputs: Record<string, unknown> = {};
    requestTimeout?: number;
    constructor(_parent?: unknown, overrides?: { requestTimeout?: number }) {
      this.requestTimeout = overrides?.requestTimeout;
    }
    input(name: string, value: unknown) {
      this.inputs[name] = value;
      return this;
    }
    async query(sql: string) {
      rec.queries.push({ sql, inputs: this.inputs, requestTimeout: this.requestTimeout });
      if (rec.failOn && sql.includes(rec.failOn)) throw new Error(`boom: ${sql}`);
      return { recordset: [{ ok: 1 }], rowsAffected: [1] };
    }
    async batch(sql: string) {
      rec.events.push(`batch:${sql}`);
      rec.batches.push({ sql, inputs: { ...this.inputs }, requestTimeout: this.requestTimeout });
      if (rec.failShowplanOff && sql.includes('SHOWPLAN_XML OFF')) {
        throw new Error('showplan off failed');
      }
      return { recordset: [] };
    }
  }
  class FakeTransaction {
    async begin() {
      rec.events.push('begin');
    }
    async commit() {
      rec.events.push('commit');
    }
    async rollback() {
      rec.events.push('rollback');
    }
  }
  class FakeConnectionPool {
    async connect() {
      if (rec.failConnectOnce) {
        rec.failConnectOnce = false;
        rec.events.push('connect-fail');
        throw new Error('connect failed');
      }
      rec.events.push('connect');
      return this;
    }
    request(overrides?: { requestTimeout?: number }) {
      return new FakeRequest(this, overrides);
    }
    async close() {
      rec.events.push('close');
    }
  }
  const api = {
    ConnectionPool: FakeConnectionPool,
    Transaction: FakeTransaction,
    Request: FakeRequest,
  };
  return { default: api, ...api };
});

// Imported after the mock (vitest hoists vi.mock above imports). The pure functions don't touch the
// driver; the executor uses the mocked ConnectionPool/Transaction/Request.
import { createMssqlExecutor, parsePlanXml, toExplainableBatch, withRowCounts } from '../src/mssql';

// ─── withRowCounts: SQLEasy's NOCOUNT prefix is why every write reported rowCount 0 ───────────────
describe('withRowCounts', () => {
  it("flips SQLEasy's NOCOUNT prefix off, so the driver still sees the DONE row counts", () => {
    expect(
      withRowCounts(`SET NOCOUNT ON; exec sp_executesql N'INSERT INTO t VALUES (1);', N'';`),
    ).toBe(`SET NOCOUNT OFF; exec sp_executesql N'INSERT INTO t VALUES (1);', N'';`);
  });

  it('tolerates the spacing and casing variations of the prefix', () => {
    expect(withRowCounts('set nocount on;SELECT 1')).toBe('SET NOCOUNT OFF;SELECT 1');
    expect(withRowCounts('  SET   NOCOUNT   ON  ; SELECT 1')).toBe('SET NOCOUNT OFF; SELECT 1');
  });

  it('leaves a statement without the prefix untouched', () => {
    expect(withRowCounts('INSERT INTO t VALUES (1);')).toBe('INSERT INTO t VALUES (1);');
  });

  it('only fires at the start, so it cannot rewrite the text inside a string literal', () => {
    // Anchoring is what makes this safe: the same bytes inside a literal must survive verbatim.
    const sql = `exec sp_executesql N'SELECT ''SET NOCOUNT ON;'' AS s;', N'';`;
    expect(withRowCounts(sql)).toBe(sql);
  });
});

// ─── toExplainableBatch: lift the inner statement out of sp_executesql (reused DeeBee cases) ──────
describe('toExplainableBatch', () => {
  it('lifts the inner statement out of an unparameterized wrapper', () => {
    expect(toExplainableBatch(`SET NOCOUNT ON; exec sp_executesql N'SELECT 1;', N'';`)).toBe(
      'SELECT 1;',
    );
  });

  it('re-declares parameters and keeps assigned values for selectivity', () => {
    const sql =
      `SET NOCOUNT ON; exec sp_executesql N'SELECT * FROM t WHERE a LIKE @p0;', ` +
      `N'@p0 nvarchar(max)', @p0 = N'%an%';`;
    expect(toExplainableBatch(sql)).toBe(
      "DECLARE @p0 nvarchar(max) = N'%an%';\nSELECT * FROM t WHERE a LIKE @p0;",
    );
  });

  it('accepts EXECUTE as well as exec', () => {
    expect(toExplainableBatch(`EXECUTE sp_executesql N'SELECT 1;', N''`)).toBe('SELECT 1;');
  });

  it("doesn't stop at a quote that is part of an escaped pair", () => {
    expect(
      toExplainableBatch(`exec sp_executesql N'SELECT CONCAT(a, '' '', b) FROM t;', N'';`),
    ).toBe(`SELECT CONCAT(a, ' ', b) FROM t;`);
  });

  it('passes a non-wrapped statement through, and falls back on an unterminated literal', () => {
    expect(toExplainableBatch('SELECT 1')).toBe('SELECT 1');
    expect(toExplainableBatch(`exec sp_executesql N'SELECT 1`)).toBe(
      `exec sp_executesql N'SELECT 1`,
    );
  });
});

// ─── parsePlanXml: cost/rows/scan out of SHOWPLAN_XML (reused DeeBee cases) ───────────────────────
describe('parsePlanXml', () => {
  const stmt = (cost: string, rows: string, text = 'x') =>
    `<StmtSimple StatementText="${text}" StatementSubTreeCost="${cost}" StatementEstRows="${rows}"/>`;

  it('takes the MOST EXPENSIVE statement, not the costless preamble', () => {
    const xml = `<ShowPlanXML>${stmt('0.000001', '0', 'DECLARE')}${stmt('4.92367', '27099.9', 'SELECT')}</ShowPlanXML>`;
    expect(parsePlanXml(xml)).toMatchObject({ cost: 4.92367, rows: 27099.9 });
  });

  it('reports no cost when the plan carries no statement', () => {
    expect(parsePlanXml('<ShowPlanXML><Nothing/></ShowPlanXML>').cost).toBeUndefined();
  });

  it('detects a full scan but not an index seek', () => {
    expect(parsePlanXml(`<x PhysicalOp="Clustered Index Scan"/>`).fullScan).toBe(true);
    expect(parsePlanXml(`<x PhysicalOp="Table Scan"/>`).fullScan).toBe(true);
    expect(parsePlanXml(`<x PhysicalOp="Clustered Index Seek"/>`).fullScan).toBe(false);
  });
});

// ─── orchestration: the mocked driver verifies the Transaction/Request wiring ─────────────────────
const batch = (name: string): { sql: string; params: never[] } => ({
  sql: `SET NOCOUNT ON; exec sp_executesql N'${name}';`,
  params: [],
});

describe('mssql orchestration', () => {
  it('run() binds params as @pN via request.input and runs the batch', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' });
    const res = await db.run({ sql: 'SELECT @p0, @p1;', params: ['a', 2] });

    expect(rec.queries[0]!.inputs).toEqual({ p0: 'a', p1: 2 });
    expect(res).toMatchObject({ rowCount: 1 });
  });

  it('transaction() begins, runs each statement, commits — no rollback', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' });
    await db.transaction([batch('INSERT'), batch('UPDATE')]);

    expect(rec.events).toContain('begin');
    expect(rec.events).toContain('commit');
    expect(rec.events).not.toContain('rollback');
    // Every statement reaches the driver with NOCOUNT flipped off, not just the first: with it on,
    // the driver reports no rows affected and each write in the transaction looks like a no-op.
    expect(rec.queries.map((q) => q.sql)).toEqual([
      `SET NOCOUNT OFF; exec sp_executesql N'INSERT';`,
      `SET NOCOUNT OFF; exec sp_executesql N'UPDATE';`,
    ]);
  });

  it('transaction() rolls back (not commits) when a statement fails', async () => {
    rec.reset('UPDATE');
    const db = createMssqlExecutor({ connectionString: 'x' });
    await expect(db.transaction([batch('INSERT'), batch('UPDATE')])).rejects.toThrow();

    expect(rec.events).toContain('rollback');
    expect(rec.events).not.toContain('commit');
  });

  it('explain() toggles SHOWPLAN_XML around the lifted statement and cleans up', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' });
    const est = await db.explain({
      sql: `SET NOCOUNT ON; exec sp_executesql N'SELECT * FROM t;', N'';`,
    });

    expect(rec.events).toContain('batch:SET SHOWPLAN_XML ON');
    expect(rec.events).toContain('batch:SELECT * FROM t'); // lifted + trailing ; stripped
    expect(rec.events).toContain('batch:SET SHOWPLAN_XML OFF');
    expect(rec.events).toContain('rollback'); // SHOWPLAN runs in a rolled-back probe transaction
    expect(est).toHaveProperty('fullScan');
  });

  it('explain() binds @pN params on the SHOWPLAN request', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' });
    await db.explain({ sql: 'SELECT * FROM t WHERE id = @p0;', params: [42] });
    const planBatch = rec.batches.find((b) => b.sql.includes('SELECT * FROM t'));
    expect(planBatch?.inputs).toEqual({ p0: 42 });
  });

  it('retires the pool when SHOWPLAN_XML OFF fails', async () => {
    rec.reset();
    rec.failShowplanOff = true;
    const db = createMssqlExecutor({ connectionString: 'x' });
    await db.explain({ sql: 'SELECT 1;' });
    expect(rec.events).toContain('close'); // poisoned pool closed
    // Next call connects on a fresh pool.
    await db.run({ sql: 'SELECT 1;', params: [] });
    expect(rec.events.filter((e) => e === 'connect').length).toBeGreaterThanOrEqual(2);
  });

  it('rebuilds the pool after a failed connect so the next call can retry', async () => {
    rec.reset();
    rec.failConnectOnce = true;
    const db = createMssqlExecutor({ connectionString: 'x' });
    await expect(db.run({ sql: 'SELECT 1;', params: [] })).rejects.toThrow(/connect failed/);
    expect(rec.events).toContain('connect-fail');
    expect(rec.events).toContain('close');
    const res = await db.run({ sql: 'SELECT 1;', params: [] });
    expect(res.rowCount).toBe(1);
    expect(rec.events).toContain('connect');
  });
});

// ─── statementTimeoutMs: a per-Request requestTimeout override, reaching the connectionString form ──
describe('mssql statementTimeoutMs', () => {
  it('sets requestTimeout on the run and transaction requests', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' }, { statementTimeoutMs: 30_000 });
    await db.run({ sql: 'SELECT 1;', params: [] });
    await db.transaction([batch('INSERT')]);
    expect(rec.queries.every((q) => q.requestTimeout === 30_000)).toBe(true);
    expect(rec.queries).not.toHaveLength(0);
  });

  it('leaves requestTimeout unset when the option is omitted', async () => {
    rec.reset();
    const db = createMssqlExecutor({ connectionString: 'x' });
    await db.run({ sql: 'SELECT 1;', params: [] });
    expect(rec.queries[0]!.requestTimeout).toBeUndefined();
  });
});

// The real-database mssql test lives in mssql.integration.test.ts — it must NOT share this file,
// whose vi.mock('mssql') would hijack the real driver.

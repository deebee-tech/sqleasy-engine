import { describe, expect, it, vi } from 'vitest';

// Shared recorder for the mssql driver mock (hoisted so it exists before the mock factory runs).
const rec = vi.hoisted(() => ({
  events: [] as string[],
  queries: [] as { sql: string; inputs: Record<string, unknown> }[],
  failOn: undefined as string | undefined,
  reset(failOn?: string) {
    this.events = [];
    this.queries = [];
    this.failOn = failOn;
  },
}));

vi.mock('mssql', () => {
  class FakeRequest {
    inputs: Record<string, unknown> = {};
    input(name: string, value: unknown) {
      this.inputs[name] = value;
      return this;
    }
    async query(sql: string) {
      rec.queries.push({ sql, inputs: this.inputs });
      if (rec.failOn && sql.includes(rec.failOn)) throw new Error(`boom: ${sql}`);
      return { recordset: [{ ok: 1 }], rowsAffected: [1] };
    }
    async batch(sql: string) {
      rec.events.push(`batch:${sql}`);
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
      rec.events.push('connect');
      return this;
    }
    request() {
      return new FakeRequest();
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
import { createMssqlExecutor, parsePlanXml, toExplainableBatch } from '../src/mssql';

// ─── toExplainableBatch: lift the inner statement out of sp_executesql (reused DeeBee cases) ──────
describe('toExplainableBatch', () => {
  it('lifts the inner statement out of an unparameterized wrapper', () => {
    expect(toExplainableBatch(`SET NOCOUNT ON; exec sp_executesql N'SELECT 1;', N'';`)).toBe(
      'SELECT 1;',
    );
  });

  it('re-declares parameters so the lifted statement compiles', () => {
    const sql =
      `SET NOCOUNT ON; exec sp_executesql N'SELECT * FROM t WHERE a LIKE @p0;', ` +
      `N'@p0 nvarchar(max)', @p0 = N'%an%';`;
    expect(toExplainableBatch(sql)).toBe(
      'DECLARE @p0 nvarchar(max);\nSELECT * FROM t WHERE a LIKE @p0;',
    );
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
    expect(rec.queries.map((q) => q.sql)).toEqual([batch('INSERT').sql, batch('UPDATE').sql]);
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
    expect(rec.events).toContain('batch:SELECT * FROM t;'); // the lifted inner statement
    expect(rec.events).toContain('batch:SET SHOWPLAN_XML OFF');
    expect(rec.events).toContain('rollback'); // SHOWPLAN runs in a rolled-back probe transaction
    expect(est).toHaveProperty('fullScan');
  });
});

// The real-database mssql test lives in mssql.integration.test.ts — it must NOT share this file,
// whose vi.mock('mssql') would hijack the real driver.

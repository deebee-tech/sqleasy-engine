// `mssql` is CommonJS and Node's ESM loader can't see its named exports — import the default and
// destructure. (pg/mysql2/@libsql expose named exports fine.)
import mssql from 'mssql';
import type { config as MssqlDriverConfig, IResult } from 'mssql';
import type { DbExecutor, ExplainEstimate, PreparedSql, QueryResult, Row } from '../index';

const { ConnectionPool, Transaction, Request } = mssql;

/** Connection settings — any `mssql` config object, or a raw connection string. */
export type MssqlConfig = MssqlDriverConfig | { connectionString: string };

/** Read the T-SQL string literal starting at `from` (just past the opening quote), honouring `''`
 * escapes. Returns the unescaped text and the index just past the closing quote. */
function readLiteral(sql: string, from: number): { text: string; end: number } | undefined {
  let out = '';
  for (let i = from; i < sql.length; i++) {
    if (sql[i] !== "'") {
      out += sql[i];
      continue;
    }
    if (sql[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    return { text: out, end: i + 1 };
  }
  return undefined; // unterminated — caller falls back to the raw batch
}

/**
 * Turn the mssql dialect's output into something SHOWPLAN can actually cost.
 *
 * It emits `SET NOCOUNT ON; exec sp_executesql N'<select>', N'<decls>'[, @p0 = …];`. SHOWPLAN does
 * NOT compile dynamic SQL, so explaining the EXEC yields a plan with no cost — the inner statement
 * must be lifted out. When it has parameters, that inner statement references `@p0`, undeclared
 * outside sp_executesql, so re-declare them. The assigned VALUES are dropped on purpose: a cost
 * estimate doesn't need them. Not a wrapped statement ⇒ returned unchanged.
 */
export function toExplainableBatch(sql: string): string {
  const m = /exec\s+sp_executesql\s+N'/i.exec(sql);
  if (!m) return sql;
  const inner = readLiteral(sql, m.index + m[0].length);
  if (!inner) return sql;
  const decl = /^\s*,\s*N'/.exec(sql.slice(inner.end));
  const decls = decl ? readLiteral(sql, inner.end + decl[0].length)?.text.trim() : '';
  return decls ? `DECLARE ${decls};\n${inner.text}` : inner.text;
}

/** Parse a SHOWPLAN_XML document into the normalized estimate. Exported for unit tests. */
export function parsePlanXml(xml: string): ExplainEstimate {
  // A batch holds one <StmtSimple> per statement (the injected DECLARE, SET NOCOUNT ON, the SELECT).
  // Take the most expensive — never blindly the first, which is usually a costless preamble.
  let best: { cost: number; rows?: number } | undefined;
  for (const [tag] of xml.matchAll(/<StmtSimple\b[^>]*>/g)) {
    const cost = Number(/StatementSubTreeCost="([\d.eE+-]+)"/.exec(tag)?.[1]);
    if (!Number.isFinite(cost) || (best && cost <= best.cost)) continue;
    const rows = Number(/StatementEstRows="([\d.eE+-]+)"/.exec(tag)?.[1]);
    best = { cost, rows: Number.isFinite(rows) ? rows : undefined };
  }
  return {
    cost: best?.cost,
    rows: best?.rows,
    fullScan: /PhysicalOp="(?:Table Scan|Clustered Index Scan|Index Scan)"/.test(xml),
    plan: xml.slice(0, 500),
  };
}

const toResult = <T>(result: IResult<unknown>): QueryResult<T> => ({
  rows: (result.recordset ?? []) as unknown as T[],
  rowCount: result.recordset ? result.recordset.length : (result.rowsAffected?.[0] ?? 0),
});

/**
 * SQLEasy's mssql dialect unconditionally prefixes `SET NOCOUNT ON; ` to every statement it emits.
 * NOCOUNT suppresses the DONE row counts that tedious reads, so `rowsAffected` came back `[]` and
 * every INSERT/UPDATE/DELETE routed through here reported `rowCount: 0` — a write that plainly
 * succeeded looked like it had touched nothing.
 *
 * Rewritten rather than stripped: forcing OFF also corrects a session that already had NOCOUNT ON,
 * whereas removing the prefix would just inherit whatever the connection was left in. The match is
 * anchored at the start of the batch, so it cannot fire on the same text inside a string literal —
 * the reason this file refuses to rewrite `?` placeholders by scanning.
 *
 * The real fix belongs upstream in SQLEasy, which has no reason to emit this at all; the prefix is
 * frozen into its cross-language golden corpus, so it cannot move without the Dart port moving in
 * lockstep.
 */
export const withRowCounts = (sql: string): string =>
  sql.replace(/^\s*SET\s+NOCOUNT\s+ON\s*;/i, 'SET NOCOUNT OFF;');

// Bind params (if any) as @p0..@pN. SQLEasy's mssql dialect inlines its values into the
// sp_executesql batch and passes `params: []`, so nothing binds on that path; a caller passing bound
// values must reference @p0.. in their SQL (mssql has no positional `?`). No `?`→`@p` rewriting —
// that scan corrupts a `?` inside a string literal. query() re-wraps its argument in sp_executesql,
// which is harmless for both a plain statement and a pre-formed batch (verified against real SQL
// Server: two sp_executesql inserts in a transaction commit both).
type BindableRequest = { input(name: string, value: unknown): unknown };
const bindParams = <R extends BindableRequest>(request: R, params?: readonly unknown[]): R => {
  (params ?? []).forEach((value, i) => request.input(`p${i}`, value));
  return request;
};

/**
 * A SQL Server executor backed by an `mssql` connection pool. Feed it the self-contained
 * `sp_executesql` batch a `MssqlQuery` builder emits (its `params` is always `[]`).
 */
export function createMssqlExecutor(config: MssqlConfig): DbExecutor {
  const makePool = () =>
    new ConnectionPool('connectionString' in config ? config.connectionString : config);
  let pool = makePool();

  // Single-flight connect that RECOVERS. Caching a rejected `pool.connect()` promise would brick the
  // pool forever (a DB restart / blip): every later query awaits the same settled rejection. So reset
  // the gate and rebuild the pool on failure, and the next call retries. (pg/mysql self-heal
  // per-acquire; mssql caches connect, so it alone needs this.)
  let ready: Promise<unknown> | undefined;
  const ensureReady = () =>
    (ready ??= pool.connect().catch((e: unknown) => {
      ready = undefined;
      const dead = pool;
      pool = makePool();
      void dead.close().catch(() => {});
      throw e;
    }));

  return {
    async run<T = Row>(prepared: PreparedSql): Promise<QueryResult<T>> {
      await ensureReady();
      const request = bindParams(pool.request(), prepared.params);
      return toResult<T>(await request.query(withRowCounts(prepared.sql)));
    },

    async transaction(statements: readonly PreparedSql[]): Promise<QueryResult[]> {
      await ensureReady();
      const tx = new Transaction(pool);
      await tx.begin();
      try {
        const results: QueryResult[] = [];
        for (const s of statements) {
          const request = bindParams(new Request(tx), s.params);
          results.push(toResult(await request.query(withRowCounts(s.sql))));
        }
        await tx.commit();
        return results;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
    },

    async explain(prepared: PreparedSql): Promise<ExplainEstimate> {
      await ensureReady();
      // SQL Server has no EXPLAIN. The estimated plan comes from SET SHOWPLAN_XML, which (a) must be
      // the ONLY statement in its batch and (b) is SESSION state — so the SET and the query must run
      // on the SAME connection. A transaction pins one connection for both; the finally block always
      // clears the flag and releases it, so SHOWPLAN never leaks onto a connection serving reads.
      const tx = new Transaction(pool);
      await tx.begin();
      try {
        await new Request(tx).batch('SET SHOWPLAN_XML ON');
        const res = await new Request(tx).batch(toExplainableBatch(prepared.sql));
        const first = res.recordset?.[0] as Row | undefined;
        return parsePlanXml(String(first ? Object.values(first)[0] : ''));
      } finally {
        await new Request(tx).batch('SET SHOWPLAN_XML OFF').catch(() => {});
        await tx.rollback().catch(() => {});
      }
    },

    async close(): Promise<void> {
      await (ready?.catch(() => {}) ?? Promise.resolve());
      await pool.close();
    },
  };
}

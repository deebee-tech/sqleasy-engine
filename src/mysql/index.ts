import {
  createPool,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
} from 'mysql2/promise';
import { explainBody } from '../explain-body';
import type {
  DbExecutor,
  ExecutorOptions,
  ExplainEstimate,
  PreparedSql,
  QueryResult,
  Row,
} from '../index';

/** Connection settings — any `mysql2` `PoolOptions`. */
export type MysqlConfig = PoolOptions;

/** `EXPLAIN FORMAT=JSON` shape — only the bits we read. A `table` node is not always a direct child
 * of `query_block`: a JOIN nests it under `nested_loop[]`, ORDER BY under `ordering_operation`, etc. */
type MysqlTable = { access_type?: string; rows_examined_per_scan?: number };
type MysqlPlan = { query_block?: { cost_info?: { query_cost?: string } } };

/**
 * Every `table` node in the plan, however deeply it is nested.
 *
 * This walks generically instead of naming the wrappers it knows about. Enumerating them is what
 * broke it before: it recursed `nested_loop`/`ordering_operation`/`grouping_operation`/
 * `duplicates_removal` and stopped there, so a UNION — whose `query_block` holds nothing but
 * `union_result.query_specifications[]` — yielded zero tables and reported `fullScan: false` while
 * scanning both branches. Verified against real MySQL 8.4, the wrappers that can hide a table are at
 * least: union_result.query_specifications[], materialized_from_subquery, attached_subqueries[],
 * select_list_subqueries[], optimized_away_subqueries[], having_subqueries[] and
 * order_by_subqueries[]. Naming those would just move the cliff to the next node MySQL adds.
 *
 * Collection stays keyed on the `table` PROPERTY, which is the one thing that reliably marks a table
 * node. That deliberately excludes `union_result` itself: it carries `access_type: "ALL"` for the
 * temporary table it reads back, which is not a base-table scan and must not be reported as one.
 */
function tablesOf(node: unknown): MysqlTable[] {
  if (Array.isArray(node)) return node.flatMap(tablesOf);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    // Recurse into the table too — a materialized derived table hangs its inner plan off it.
    key === 'table' && value !== null && typeof value === 'object'
      ? [value as MysqlTable, ...tablesOf(value)]
      : tablesOf(value),
  );
}

/** Full-table or full-index scan access types — portable "this will hurt" signals. */
const isFullScanAccess = (accessType: string | undefined): boolean =>
  accessType === 'ALL' || accessType === 'index';

/** Parse `EXPLAIN FORMAT=JSON` output into the normalized estimate. Exported for unit tests. */
export function parseMysqlPlan(raw: string): ExplainEstimate {
  let plan: MysqlPlan = {};
  try {
    plan = JSON.parse(raw || '{}') as MysqlPlan;
  } catch {
    // Unparseable plan — an empty estimate beats throwing.
  }
  const cost = Number(plan.query_block?.cost_info?.query_cost);
  const tables = tablesOf(plan.query_block);
  return {
    cost: Number.isFinite(cost) ? cost : undefined,
    // The driving (first) table's scanned rows.
    rows: tables[0]?.rows_examined_per_scan,
    // `ALL` = full table scan; `index` = full index scan — either hurts like a full read.
    fullScan: tables.some((t) => isFullScanAccess(t.access_type)),
    plan: (raw ?? '').slice(0, 500),
  };
}

const argsOf = (prepared: PreparedSql): unknown[] => (prepared.params ?? []) as unknown[];

// mysql2's query() resolves to `[rows | ResultSetHeader, fields]`. SELECT → an array of rows; a
// write → a ResultSetHeader carrying affectedRows.
const toResult = <T>(result: unknown): QueryResult<T> => {
  if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
  return { rows: [], rowCount: (result as ResultSetHeader).affectedRows ?? 0 };
};

/**
 * Options for a MySQL executor.
 *
 * @deprecated Use the shared {@link ExecutorOptions} — this is now an alias for it. MySQL realizes
 * `statementTimeoutMs` as a per-query client timeout: on expiry `mysql2` destroys the connection,
 * which makes the server kill the running statement (MySQL has no pool-level query-timeout config).
 */
export type MysqlExecutorOptions = ExecutorOptions;

/**
 * Build a MySQL executor over an EXISTING pool — bring your own `mysql2` Pool to share one across
 * your app (or hand in a test double). {@link close} is a no-op: you own the pool's lifetime.
 * Prefer {@link createMysqlExecutor} when the engine should create and close the pool.
 */
export function createMysqlExecutorFromPool(
  pool: Pool,
  opts: MysqlExecutorOptions = {},
): DbExecutor {
  const { statementTimeoutMs } = opts;
  // mysql2 has no pool-level query timeout — apply it per statement via the object form, on both the
  // pool (run/explain) and a checked-out connection (transaction).
  const query = (target: Pool | PoolConnection, sql: string, args: unknown[]) =>
    statementTimeoutMs != null
      ? target.query({ sql, timeout: statementTimeoutMs }, args)
      : target.query(sql, args);

  return {
    async run<T = Row>(prepared: PreparedSql): Promise<QueryResult<T>> {
      const [result] = await query(pool, prepared.sql, argsOf(prepared));
      return toResult<T>(result);
    },

    async transaction(statements: readonly PreparedSql[]): Promise<QueryResult[]> {
      // Driver-level transaction on a single pinned connection — beginTransaction/commit/rollback
      // speak the protocol correctly (no `multipleStatements`, no concatenation). Each statement
      // runs on its own; ROLLBACK on any error; release (or destroy) the connection no matter what.
      const conn = await pool.getConnection();
      let destroy = false;
      try {
        await conn.beginTransaction();
        const results: QueryResult[] = [];
        for (const s of statements) {
          const [result] = await query(conn, s.sql, argsOf(s));
          results.push(toResult(result));
        }
        await conn.commit();
        return results;
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          // A failed rollback often means the connection is dead — destroy instead of pooling it.
          destroy = true;
        }
        throw err;
      } finally {
        if (destroy) conn.destroy();
        else conn.release();
      }
    },

    async explain(prepared: PreparedSql): Promise<ExplainEstimate> {
      // EXPLAIN never executes the statement; FORMAT=JSON is the only form carrying a cost estimate.
      const [rows] = await query(
        pool,
        `EXPLAIN FORMAT=JSON ${explainBody(prepared.sql)}`,
        argsOf(prepared),
      );
      const raw = Array.isArray(rows) ? (rows[0] as { EXPLAIN?: string } | undefined)?.EXPLAIN : '';
      return parseMysqlPlan(raw ?? '');
    },

    async close(): Promise<void> {
      // Caller-owned pool — ending it here would take down every other user of the shared pool.
    },
  };
}

/**
 * A MySQL / MariaDB executor backed by a `mysql2` connection pool (placeholders: `?`). Accepts any
 * `{ sql, params }` — SQLEasy builders are one producer, not the only one. Pass
 * `{ statementTimeoutMs }` for a per-statement ceiling (MySQL has no pool-level knob for it).
 * {@link close} ends the pool this factory created.
 */
export function createMysqlExecutor(
  config: MysqlConfig,
  opts: MysqlExecutorOptions = {},
): DbExecutor {
  const pool = createPool(config);
  const executor = createMysqlExecutorFromPool(pool, opts);
  return {
    run: (prepared) => executor.run(prepared),
    transaction: (statements) => executor.transaction(statements),
    explain: (prepared) => executor.explain(prepared),
    async close() {
      await pool.end();
    },
  };
}

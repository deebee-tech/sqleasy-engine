import { createPool, type Pool, type PoolOptions, type ResultSetHeader } from 'mysql2/promise';
import type { DbExecutor, ExplainEstimate, PreparedSql, QueryResult, Row } from '../index';

/** Connection settings — any `mysql2` `PoolOptions`. */
export type MysqlConfig = PoolOptions;

/** `EXPLAIN FORMAT=JSON` shape — only the bits we read. A `table` node is not always a direct child
 * of `query_block`: a JOIN nests it under `nested_loop[]`, ORDER BY under `ordering_operation`, etc. */
type MysqlTable = { access_type?: string; rows_examined_per_scan?: number };
type MysqlBlock = {
  cost_info?: { query_cost?: string };
  table?: MysqlTable;
  nested_loop?: MysqlBlock[];
  ordering_operation?: MysqlBlock;
  grouping_operation?: MysqlBlock;
  duplicates_removal?: MysqlBlock;
};
type MysqlPlan = { query_block?: MysqlBlock };

/** Every `table` node in the plan, however deeply the operation wrappers nest it. */
function tablesOf(block: MysqlBlock | undefined): MysqlTable[] {
  if (!block) return [];
  return [
    ...(block.table ? [block.table] : []),
    ...(block.nested_loop ?? []).flatMap(tablesOf),
    ...tablesOf(block.ordering_operation),
    ...tablesOf(block.grouping_operation),
    ...tablesOf(block.duplicates_removal),
  ];
}

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
    // `ALL` is MySQL's full-table-scan access type — a scan ANYWHERE in the plan counts.
    fullScan: tables.some((t) => t.access_type === 'ALL'),
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
 * Build a MySQL executor over an EXISTING pool — bring your own `mysql2` Pool to share one across
 * your app (or hand in a test double). {@link createMysqlExecutor} is the usual entry.
 */
export function createMysqlExecutorFromPool(pool: Pool): DbExecutor {
  return {
    async run<T = Row>(prepared: PreparedSql): Promise<QueryResult<T>> {
      const [result] = await pool.query(prepared.sql, argsOf(prepared));
      return toResult<T>(result);
    },

    async transaction(statements: readonly PreparedSql[]): Promise<QueryResult[]> {
      // Driver-level transaction on a single pinned connection — beginTransaction/commit/rollback
      // speak the protocol correctly (no `multipleStatements`, no concatenation). Each statement
      // runs on its own; ROLLBACK on any error; release the connection no matter what.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const results: QueryResult[] = [];
        for (const s of statements) {
          const [result] = await conn.query(s.sql, argsOf(s));
          results.push(toResult(result));
        }
        await conn.commit();
        return results;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },

    async explain(prepared: PreparedSql): Promise<ExplainEstimate> {
      // EXPLAIN never executes the statement; FORMAT=JSON is the only form carrying a cost estimate.
      const [rows] = await pool.query(`EXPLAIN FORMAT=JSON ${prepared.sql}`, argsOf(prepared));
      const raw = Array.isArray(rows) ? (rows[0] as { EXPLAIN?: string } | undefined)?.EXPLAIN : '';
      return parseMysqlPlan(raw ?? '');
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * A MySQL / MariaDB executor backed by a `mysql2` connection pool (placeholders: `?`). Feed it the
 * `{ sql, params }` a `MysqlQuery` builder emits.
 */
export function createMysqlExecutor(config: MysqlConfig): DbExecutor {
  return createMysqlExecutorFromPool(createPool(config));
}

/**
 * Core, driver-agnostic types for the SQLEasy engine.
 *
 * This entry point pulls in NO database driver — importing it is free. Pick a dialect executor from
 * its own subpath (`@deebeetech/sqleasy-engine/sqlite`, `/postgres`, …); each one imports only its
 * own driver, so you install and load just the drivers you use.
 */

/** A single result-set row, keyed by column name. */
export type Row = Record<string, unknown>;

/**
 * A prepared statement and its ordered bound parameters.
 *
 * Structural on purpose: the engine accepts any `{ sql, params }` and never depends on a particular
 * SQL builder. SQLEasy's `parsePrepared()` / `preparedStatements()` produce this shape, but so can
 * hand-written SQL, another codegen tool, or an ORM adapter. `params` is optional when the SQL
 * carries its own values (e.g. an mssql `sp_executesql` batch with inlined assignments).
 */
export type PreparedSql = {
  sql: string;
  params?: readonly unknown[];
};

/** The outcome of executing one statement. */
export type QueryResult<T = Row> = {
  rows: T[];
  /** Rows returned (SELECT) or affected (INSERT/UPDATE/DELETE). */
  rowCount: number;
};

/**
 * The planner's estimate for a statement, obtained WITHOUT executing it. `cost` is in the dialect's
 * own units and is NOT comparable across dialects — gate on `rows`/`fullScan` when you need one rule
 * for all four. Best-effort: a backend supplies only what its planner exposes (SQLite has no
 * numbers at all, only the plan shape).
 */
export type ExplainEstimate = {
  /** Planner cost in the dialect's own units. Absent when the backend reports none (SQLite). */
  cost?: number;
  /** Estimated rows the plan produces. Absent when the backend reports none (SQLite). */
  rows?: number;
  /** The plan reads a whole table instead of seeking an index — the portable "this will hurt" signal. */
  fullScan: boolean;
  /** A short raw-plan excerpt, for display and debugging. */
  plan: string;
};

/**
 * Executes prepared SQL against one database.
 *
 * Obtain one from a dialect subpath (`createSqliteExecutor`, `createPostgresExecutor`, …). Pick the
 * executor whose dialect matches the SQL you built, so placeholders and quoting line up — the engine
 * runs what it is given verbatim and does not rewrite dialects.
 */
export type DbExecutor = {
  /** Run one prepared statement and return its rows. */
  run<T = Row>(prepared: PreparedSql): Promise<QueryResult<T>>;
  /**
   * Run several prepared statements as ONE atomic transaction: commit on success, roll back on any
   * error. Statements run in order, each as its own prepared statement (never concatenated into one
   * string, which would misbind: placeholder numbering restarts per statement), and each statement's
   * result is returned in the same order. A common producer is SQLEasy's
   * `MultiBuilder.preparedStatements()`, but any `{ sql, params }[]` works.
   */
  transaction(statements: readonly PreparedSql[]): Promise<QueryResult[]>;
  /**
   * Ask the planner what a statement would cost WITHOUT running it. Best-effort per backend.
   * Expects a single statement (`explain()` rejects multi-statement batches). Bound `params` are
   * applied so selectivity reaches the planner.
   */
  explain(prepared: PreparedSql): Promise<ExplainEstimate>;
  /**
   * Release resources this executor owns. Factory-created executors end their pool/client;
   * `…FromPool` variants are a no-op so a shared app pool is not torn down by accident.
   */
  close(): Promise<void>;
};

/**
 * Options common to every dialect executor factory.
 */
export type ExecutorOptions = {
  /**
   * Per-statement timeout in milliseconds — a ceiling on how long ONE statement may run before it is
   * aborted. Omit for no timeout. Each dialect realizes it with its native mechanism:
   *
   * - **Postgres** — `statement_timeout` merged into the pool config (server-enforced; the backend
   *   cancels the statement). A no-op on `createPostgresExecutorFromPool`, whose foreign pool owns
   *   its own config.
   * - **MySQL** — a per-query client timeout; on expiry `mysql2` destroys the connection, which
   *   makes the server kill the running statement.
   * - **MSSQL** — a per-`Request` `requestTimeout`; the driver cancels the request on expiry.
   * - **SQLite / libSQL** — a client-side deadline that rejects the awaited promise. Best-effort:
   *   `@libsql/client` has no `interrupt()`, so a running REMOTE (Turso) statement keeps burning
   *   server time after the reject; local file work is bounded in practice.
   */
  statementTimeoutMs?: number;
};

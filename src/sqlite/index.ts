import { createClient, type Config, type InArgs, type ResultSet } from '@libsql/client';
import { explainBody } from '../explain-body';
import type {
  DbExecutor,
  ExecutorOptions,
  ExplainEstimate,
  PreparedSql,
  QueryResult,
  Row,
} from '../index';

/**
 * How to reach the database. Either a full `@libsql/client` {@link Config} (a Turso/libSQL `url` +
 * `authToken`, an in-memory `':memory:'`, …) or the shorthand `{ file }` for a local SQLite file.
 */
export type SqliteConfig = Config | { file: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SQLite's "another connection holds the lock" signal — a statement that never ran, safe to retry. */
const isBusy = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
};

// Up to ~6.3s of extra waiting beyond the busy timeout, then give up and surface the error.
const BUSY_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200];

const argsOf = (prepared: PreparedSql): InArgs => (prepared.params ?? []) as InArgs;

const toResult = <T>(rs: ResultSet): QueryResult<T> => {
  const rows = rs.rows as unknown as T[];
  // SELECT → row count; write → affected count (rows is empty).
  return { rows, rowCount: rows.length > 0 ? rows.length : rs.rowsAffected };
};

/**
 * A SQLite / libSQL / Turso executor backed by `@libsql/client` (placeholders: `?`). Accepts any
 * `{ sql, params }` — SQLEasy builders are one producer, not the only one.
 */
export function createSqliteExecutor(config: SqliteConfig, opts: ExecutorOptions = {}): DbExecutor {
  const { statementTimeoutMs } = opts;
  const clientConfig: Config = 'file' in config ? { url: `file:${config.file}` } : config;
  const client = createClient(clientConfig);

  // A local SQLite FILE can be open in more than one connection at once (SQLite allows one writer),
  // so two defenses, only for file URLs — remote libSQL/Turso has no such lock:
  //   1. a busy timeout, so a briefly-held lock is waited out instead of throwing on the spot;
  //   2. a bounded retry, because under sustained reader pressure the timeout can still lapse. A
  //      SQLITE_BUSY means the statement did not run, so retrying — read OR write — repeats nothing;
  //      a transaction batch rolls back fully before it surfaces, so retrying it is equally safe.
  const isLocalFile = typeof clientConfig.url === 'string' && clientConfig.url.startsWith('file:');

  let busyTimeout: Promise<void> | undefined;
  const ensureBusyTimeout = (): Promise<void> => {
    if (!isLocalFile) return Promise.resolve();
    // Cached and best-effort: a driver that rejects the pragma must not break the executor.
    busyTimeout ??= client.execute('PRAGMA busy_timeout = 5000').then(
      () => {},
      () => {},
    );
    return busyTimeout;
  };

  // ponytail: @libsql/client exposes no interrupt(), so this bounds the AWAITED promise but cannot
  // cancel a running REMOTE statement — a long Turso query keeps burning server time after we reject.
  // Per-attempt (not one absolute deadline across busy-retries) is fine: a genuinely slow statement
  // is not busy, so it rejects on the first attempt and never loops; only SQLITE_BUSY loops, and that
  // fails fast under the 5s busy_timeout. Upgrade to an absolute deadline only if that ceiling bites.
  const withDeadline = <R>(op: () => Promise<R>): Promise<R> => {
    if (statementTimeoutMs == null) return op();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`sqleasy-engine: statement exceeded ${statementTimeoutMs}ms timeout`)),
        statementTimeoutMs,
      );
    });
    return Promise.race([op(), deadline]).finally(() => clearTimeout(timer));
  };

  const withBusyRetry = async <R>(op: () => Promise<R>): Promise<R> => {
    await ensureBusyTimeout();
    for (let attempt = 0; ; attempt++) {
      try {
        return await withDeadline(op);
      } catch (err) {
        if (!isLocalFile || !isBusy(err) || attempt >= BUSY_RETRY_DELAYS_MS.length) throw err;
        await sleep(BUSY_RETRY_DELAYS_MS[attempt]!);
      }
    }
  };

  return {
    async run<T = Row>(prepared: PreparedSql): Promise<QueryResult<T>> {
      const rs = await withBusyRetry(() =>
        client.execute({ sql: prepared.sql, args: argsOf(prepared) }),
      );
      return toResult<T>(rs);
    },

    async transaction(statements: readonly PreparedSql[]): Promise<QueryResult[]> {
      // `batch` runs every statement in ONE transaction and rolls back on any error — exactly the
      // multi-builder contract, and each statement stays its own prepared statement.
      const results = await withBusyRetry(() =>
        client.batch(
          statements.map((s) => ({ sql: s.sql, args: argsOf(s) })),
          'write',
        ),
      );
      return results.map((rs) => toResult(rs));
    },

    async explain(prepared: PreparedSql): Promise<ExplainEstimate> {
      // SQLite's planner exposes no cost or row estimate — only the plan SHAPE. `SCAN` means a full
      // table scan, `SEARCH` an index seek, so `fullScan` is the only signal this dialect gives.
      const rs = await withBusyRetry(() =>
        client.execute({
          sql: `EXPLAIN QUERY PLAN ${explainBody(prepared.sql)}`,
          args: argsOf(prepared),
        }),
      );
      const details = rs.rows.map((r) =>
        String((r as unknown as { detail?: string }).detail ?? ''),
      );
      return {
        fullScan: details.some((d) => d.startsWith('SCAN')),
        plan: details.join('; ').slice(0, 500),
      };
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}

import { describe, expect, it } from 'vitest';
import { createMssqlExecutor } from '../src/mssql';

// Real SQL Server, gated on MSSQL_CONNECTION_STRING (a CI service). This lives in its OWN file on
// purpose: mssql.test.ts mocks the `mssql` module with vi.mock, which would hijack the real driver
// here and quietly make this run against fakes. No mock in this file — it exercises node-mssql.
const MSSQL_CONNECTION_STRING = process.env['MSSQL_CONNECTION_STRING'];

// Verbatim MssqlQuery output: a self-contained sp_executesql batch, params [].
const insert = (id: number, name: string) => ({
  sql:
    `SET NOCOUNT ON; exec sp_executesql N'INSERT INTO _sqleasy_engine_it (id, name) ` +
    `VALUES (@p0, @p1);', N'@p0 int, @p1 nvarchar(max)', @p0 = ${id}, @p1 = N'${name}';`,
  params: [] as never[],
});

describe.skipIf(!MSSQL_CONNECTION_STRING)('mssql executor (real database)', () => {
  it('commits a transaction atomically and rolls back on failure', async () => {
    // Built inside the test, not the describe body: the describe callback runs even when skipped,
    // and the real driver throws on an undefined connection string.
    const db = createMssqlExecutor({ connectionString: MSSQL_CONNECTION_STRING! });
    const count = async () =>
      (await db.run<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM _sqleasy_engine_it;' }))
        .rows[0]!.n;

    await db.run({
      sql: "IF OBJECT_ID('_sqleasy_engine_it') IS NOT NULL DROP TABLE _sqleasy_engine_it;",
    });
    await db.run({
      sql: 'CREATE TABLE _sqleasy_engine_it (id INT PRIMARY KEY, name NVARCHAR(200));',
    });
    try {
      await db.transaction([insert(1, 'Ada'), insert(2, 'Grace')]);
      expect(await count()).toBe(2);

      await expect(db.transaction([insert(3, 'Bob'), insert(1, 'Dup')])).rejects.toThrow();
      expect(await count()).toBe(2); // Bob rolled back with the failed batch
    } finally {
      await db
        .run({
          sql: "IF OBJECT_ID('_sqleasy_engine_it') IS NOT NULL DROP TABLE _sqleasy_engine_it;",
        })
        .catch(() => {});
      await db.close();
    }
  });

  // Only a real server can catch this: the driver mock in mssql.test.ts hands back a canned
  // `rowsAffected: [1]`, so it reports a healthy rowCount no matter what the SQL says. Against real
  // SQL Server every write here returned 0 — SQLEasy's `SET NOCOUNT ON;` prefix suppresses the DONE
  // row counts tedious reads, leaving `rowsAffected` empty. A caller checking "did my write land?"
  // saw a successful statement claim it touched nothing.
  it('reports a truthful rowCount for writes, despite the NOCOUNT prefix', async () => {
    const db = createMssqlExecutor({ connectionString: MSSQL_CONNECTION_STRING! });
    try {
      await db.run({
        sql: "IF OBJECT_ID('_sqleasy_engine_rc') IS NOT NULL DROP TABLE _sqleasy_engine_rc;",
      });
      await db.run({
        sql: 'CREATE TABLE _sqleasy_engine_rc (id INT PRIMARY KEY, name NVARCHAR(200));',
      });

      const one = await db.run({
        sql:
          `SET NOCOUNT ON; exec sp_executesql N'INSERT INTO _sqleasy_engine_rc (id, name) ` +
          `VALUES (@p0, @p1);', N'@p0 int, @p1 nvarchar(max)', @p0 = 1, @p1 = N'Ada';`,
        params: [],
      });
      expect(one.rowCount).toBe(1);

      // Every statement in a transaction must report its own count, not just the first.
      const many = await db.transaction([
        {
          sql:
            `SET NOCOUNT ON; exec sp_executesql N'INSERT INTO _sqleasy_engine_rc (id, name) ` +
            `VALUES (@p0, @p1);', N'@p0 int, @p1 nvarchar(max)', @p0 = 2, @p1 = N'Grace';`,
          params: [],
        },
        {
          sql:
            `SET NOCOUNT ON; exec sp_executesql N'UPDATE _sqleasy_engine_rc SET name = @p0;', ` +
            `N'@p0 nvarchar(max)', @p0 = N'Renamed';`,
          params: [],
        },
      ]);
      expect(many.map((r) => r.rowCount)).toEqual([1, 2]);

      // The prefix must not cost us the rows on a SELECT, which is the path that always worked.
      const read = await db.run<{ n: number }>({
        sql: `SET NOCOUNT ON; exec sp_executesql N'SELECT COUNT(*) AS n FROM _sqleasy_engine_rc;', N'';`,
        params: [],
      });
      expect(read.rows[0]!.n).toBe(2);
    } finally {
      await db
        .run({
          sql: "IF OBJECT_ID('_sqleasy_engine_rc') IS NOT NULL DROP TABLE _sqleasy_engine_rc;",
        })
        .catch(() => {});
      await db.close();
    }
  });
});

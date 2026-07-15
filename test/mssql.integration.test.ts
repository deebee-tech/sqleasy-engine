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
});

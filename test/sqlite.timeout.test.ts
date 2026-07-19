import { describe, expect, it, vi } from 'vitest';

// The statementTimeoutMs deadline can only be observed against a statement that outlives it, so this
// file mocks @libsql/client with an execute() that never settles when `rec.hang` is set. It mocks the
// driver and so must NOT hold the real in-memory tests (those live in sqlite.test.ts).
const rec = vi.hoisted(() => ({ hang: false }));

vi.mock('@libsql/client', () => {
  class FakeClient {
    async execute(): Promise<unknown> {
      if (rec.hang) return new Promise(() => {}); // never settles → the deadline must fire
      return { rows: [], rowsAffected: 0, columns: [] };
    }
    async batch(): Promise<unknown> {
      if (rec.hang) return new Promise(() => {});
      return [];
    }
    close() {}
  }
  return { createClient: () => new FakeClient() };
});

import { createSqliteExecutor } from '../src/sqlite';

describe('sqlite statementTimeoutMs', () => {
  it('rejects a statement that outruns the deadline', async () => {
    rec.hang = true;
    const db = createSqliteExecutor({ url: ':memory:' }, { statementTimeoutMs: 20 });
    await expect(db.run({ sql: 'SELECT 1;', params: [] })).rejects.toThrow(/exceeded 20ms/);
    rec.hang = false;
    await db.close();
  });

  it('applies the deadline to the transaction path too', async () => {
    rec.hang = true;
    const db = createSqliteExecutor({ url: ':memory:' }, { statementTimeoutMs: 20 });
    await expect(
      db.transaction([{ sql: 'INSERT INTO t VALUES (1);', params: [] }]),
    ).rejects.toThrow(/exceeded 20ms/);
    rec.hang = false;
    await db.close();
  });

  it('does not arm a deadline when the option is omitted (a fast op still resolves)', async () => {
    rec.hang = false;
    const db = createSqliteExecutor({ url: ':memory:' });
    await expect(db.run({ sql: 'SELECT 1;', params: [] })).resolves.toBeDefined();
    await db.close();
  });
});

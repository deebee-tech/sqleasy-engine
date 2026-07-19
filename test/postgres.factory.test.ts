import { describe, expect, it, vi } from 'vitest';

// The pg `Pool` is constructed inside createPostgresExecutor, so intercept it to inspect the config
// it is built with and the listeners it attaches. This file mocks 'pg' and therefore must NOT hold
// the gated real-database test (that lives in postgres.test.ts) — a mock would hijack the real pool.
const rec = vi.hoisted(() => ({
  constructed: [] as {
    config: Record<string, unknown>;
    errorListeners: ((e: unknown) => void)[];
  }[],
}));

vi.mock('pg', () => {
  class FakePool {
    errorListeners: ((e: unknown) => void)[] = [];
    constructor(public config: Record<string, unknown>) {
      rec.constructed.push({ config, errorListeners: this.errorListeners });
    }
    on(event: string, cb: (e: unknown) => void) {
      if (event === 'error') this.errorListeners.push(cb);
      return this;
    }
    async query() {
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    }
    async end() {}
  }
  return { Pool: FakePool };
});

import { createPostgresExecutor } from '../src/postgres';

describe('createPostgresExecutor factory options', () => {
  const last = () => rec.constructed.at(-1)!;

  it('merges statementTimeoutMs into the pool config as statement_timeout', () => {
    createPostgresExecutor({ host: 'h' }, { statementTimeoutMs: 30_000 });
    expect(last().config.statement_timeout).toBe(30_000);
  });

  it('lets an explicit statementTimeoutMs win over a config-level statement_timeout', () => {
    createPostgresExecutor({ host: 'h', statement_timeout: 1_000 }, { statementTimeoutMs: 5_000 });
    expect(last().config.statement_timeout).toBe(5_000);
  });

  it('keeps a config-level statement_timeout when the option is omitted', () => {
    createPostgresExecutor({ host: 'h', statement_timeout: 2_000 });
    expect(last().config.statement_timeout).toBe(2_000);
  });

  it('leaves statement_timeout undefined when neither is set', () => {
    createPostgresExecutor({ host: 'h' });
    expect(last().config.statement_timeout).toBeUndefined();
  });

  it('attaches a pool error listener so an idle-client error cannot crash the process', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createPostgresExecutor({ host: 'h' });
    const listeners = last().errorListeners;
    expect(listeners.length).toBeGreaterThan(0);
    // Emitting the error must not throw — the pool discards the dead client and heals.
    expect(() => listeners[0]!(new Error('idle client'))).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

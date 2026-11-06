import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

// A thin, synchronous wrapper over sql.js (SQLite compiled to WebAssembly, no native build).

export type Row = Record<string, SqlValue>;
export type Params = SqlValue[] | Record<string, SqlValue>;

let engine: Promise<SqlJsStatic> | undefined;

export async function openDb(bytes?: Uint8Array): Promise<Db> {
  engine ??= initSqlJs();
  const SQL = await engine;
  return new Db(new SQL.Database(bytes));
}

export class Db {
  constructor(readonly raw: Database) {}

  all<T = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  run(sql: string, params: Params = []): void {
    this.raw.run(sql, params);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs fn in one transaction: all of it commits, or none of it does. */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** After this, any statement that would write fails inside SQLite itself. */
  makeReadOnly(): void {
    this.raw.exec('PRAGMA query_only = ON');
  }

  export(): Uint8Array {
    return this.raw.export();
  }

  close(): void {
    this.raw.close();
  }
}

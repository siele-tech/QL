import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { ADDED_COLUMNS, SCHEMA } from './schema.ts';

type Param = string | number | bigint | null | Uint8Array;
export type Row = any; // rows are validated at the API boundary; keep data-access typing light

/**
 * Thin data-access wrapper over Node's built-in SQLite driver.
 * All SQL uses bound parameters (never string interpolation of user input).
 */
class Database {
  private db!: DatabaseSync;
  private depth = 0;

  open(file = config.databasePath) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
    return this;
  }
  /** Additive migrations: add columns introduced after the first release. */
  private migrate() {
    for (const [table, column, def] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  }
  close() { this.db?.close(); }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params.map(norm)) as T[];
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params.map(norm)) as T | undefined;
  }
  run(sql: string, ...params: Param[]) {
    return this.db.prepare(sql).run(...params.map(norm));
  }
  exec(sql: string) { this.db.exec(sql); }

  /** Insert a row from an object. */
  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    this.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  }
  /** Update columns of a row by primary key column `id` (or custom). */
  update(table: string, id: string, patch: Row, idCol = 'id') {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, ...keys.map((k) => patch[k]), id);
  }

  /** Run fn atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.depth = 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }
}

function norm(v: any): Param {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export const db = new Database();
export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

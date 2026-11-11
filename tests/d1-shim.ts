// Minimal D1Database implementation over Node's built-in SQLite, so the real
// app and the real migrations run in tests without a Cloudflare account.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plain = (r: any) => (r ? { ...r } : null);

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)));
  }
  async first<T = any>(col?: string): Promise<T | null> {
    const r = plain(this.db.prepare(this.sql).get(...(this.params as any[])));
    if (!r) return null;
    return (col ? r[col] : r) as T;
  }
  async all<T = any>() {
    const rows = this.db.prepare(this.sql).all(...(this.params as any[])).map(plain) as T[];
    return { results: rows, success: true, meta: {} };
  }
  async run() {
    const res = this.db.prepare(this.sql).run(...(this.params as any[]));
    return { success: true, results: [], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  async raw() {
    return this.db.prepare(this.sql).all(...(this.params as any[])).map((r: any) => Object.values(r));
  }
  runSync() {
    return this.db.prepare(this.sql).run(...(this.params as any[]));
  }
}

export class ShimD1 {
  db: DatabaseSync;
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runSync());
      this.db.exec('COMMIT');
      return out.map((r) => ({ success: true, meta: { changes: Number(r.changes) } }));
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export function freshDb(): ShimD1 {
  const d = new ShimD1();
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) d.db.exec(readFileSync(join(dir, f), 'utf8'));
  return d;
}

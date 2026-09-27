import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { APP_ROOT } from './config.js';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(APP_ROOT, 'migrations');

export function openDb(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Applies every migrations/NNN_*.sql not yet recorded, each in its own transaction.
export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[],
  );
  const pending = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => !applied.has(f));

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    })();
  }
  return pending;
}

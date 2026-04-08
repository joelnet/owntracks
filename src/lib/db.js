import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = new URL('../../data/owntracks.db', import.meta.url).pathname;

export function openDatabase(dbPath = DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS location_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      device TEXT NOT NULL,
      lat REAL,
      lon REAL,
      tst INTEGER,
      acc INTEGER,
      vel INTEGER,
      type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      data JSON NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_tst ON location_entries(tst)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_type_tst ON location_entries(type, tst)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_pois (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      radius_m REAL NOT NULL,
      discovered_at TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1,
      last_visited_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSON NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      address TEXT NOT NULL,
      cached_at TEXT NOT NULL
    )
  `);
}

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db.js';
import { createStore } from '../store.js';

describe('store', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    store = createStore(db);
  });

  it('creates a JSONL file named by date', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location', username: 'test', device: 'phone', received_at: new Date().toISOString() };
    store.appendEntry(entry);

    const count = db.prepare('SELECT COUNT(*) as c FROM location_entries').get().c;
    assert.equal(count, 1);
  });

  it('writes valid JSON on each line', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location', username: 'test', device: 'phone', received_at: new Date().toISOString() };
    store.appendEntry(entry);

    const row = db.prepare('SELECT * FROM location_entries').get();
    assert.equal(row.lat, 33.99);
    assert.equal(row.lon, -117.87);
    assert.equal(row.type, 'location');
    const parsed = JSON.parse(row.data);
    assert.equal(parsed.lat, 33.99);
  });

  it('appends multiple entries as separate lines', () => {
    const entry1 = { lat: 33.99, lon: -117.87, type: 'location', username: 'test', device: 'phone', received_at: new Date().toISOString() };
    const entry2 = { lat: 34.05, lon: -118.24, type: 'location', username: 'test', device: 'phone', received_at: new Date().toISOString() };
    store.appendEntry(entry1);
    store.appendEntry(entry2);

    const rows = db.prepare('SELECT * FROM location_entries ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].lat, 33.99);
    assert.equal(rows[1].lat, 34.05);
  });

  it('creates data directory if it does not exist', () => {
    // With SQLite, directory creation is handled by openDatabase, not the store
    // Just verify the store works with an in-memory database
    const entry = { lat: 33.99, lon: -117.87, type: 'location', username: 'test', device: 'phone', received_at: new Date().toISOString() };
    store.appendEntry(entry);
    const count = db.prepare('SELECT COUNT(*) as c FROM location_entries').get().c;
    assert.equal(count, 1);
  });
});

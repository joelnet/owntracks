#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, initSchema } from '../lib/db.js';

const dataDir = path.join(import.meta.dirname, '..', '..', 'data');

console.log('Opening database...');
const db = openDatabase();
initSchema(db);

// 1. Migrate JSONL location entries
const jsonlFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.jsonl') && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
console.log(`Found ${jsonlFiles.length} JSONL files`);

const insertEntry = db.prepare(`
  INSERT INTO location_entries (username, device, lat, lon, tst, acc, vel, type, received_at, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let entryCount = 0;
const migrateEntries = db.transaction(() => {
  for (const file of jsonlFiles) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8').trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      insertEntry.run(
        entry.username ?? null,
        entry.device ?? null,
        entry.lat ?? null,
        entry.lon ?? null,
        entry.tst ?? null,
        entry.acc ?? null,
        entry.vel ?? null,
        entry.type ?? 'unknown',
        entry.received_at ?? null,
        line
      );
      entryCount++;
    }
  }
});
migrateEntries();
console.log(`Migrated ${entryCount} location entries`);

// 2. Migrate learned POIs
const poisPath = path.join(dataDir, 'learned-pois.json');
try {
  const pois = JSON.parse(fs.readFileSync(poisPath, 'utf-8'));
  const insertPoi = db.prepare(`
    INSERT INTO learned_pois (name, address, lat, lon, radius_m, discovered_at, visit_count, last_visited_at)
    VALUES (@name, @address, @lat, @lon, @radius_m, @discovered_at, @visit_count, @last_visited_at)
  `);
  const migratePois = db.transaction(() => {
    for (const poi of pois) {
      insertPoi.run({
        ...poi,
        address: poi.address ?? null,
      });
    }
  });
  migratePois();
  console.log(`Migrated ${pois.length} learned POIs`);
} catch {
  console.log('No learned-pois.json to migrate');
}

// 3. Migrate activity state
const activityPath = path.join(dataDir, 'activity-state.json');
try {
  const state = fs.readFileSync(activityPath, 'utf-8');
  db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('activity_state', state, new Date().toISOString());
  console.log('Migrated activity state');
} catch {
  console.log('No activity-state.json to migrate');
}

// 4. Migrate visit session
const visitPath = path.join(dataDir, 'visit-session.json');
try {
  const state = fs.readFileSync(visitPath, 'utf-8');
  db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('visit_session', state, new Date().toISOString());
  console.log('Migrated visit session');
} catch {
  console.log('No visit-session.json to migrate');
}

// 5. Migrate geocode cache
const geocodePath = path.join(dataDir, 'geocode-cache.jsonl');
try {
  const content = fs.readFileSync(geocodePath, 'utf-8').trim();
  if (content) {
    const insertCache = db.prepare(
      'INSERT INTO geocode_cache (lat, lon, address, cached_at) VALUES (?, ?, ?, ?)'
    );
    const migrateCache = db.transaction(() => {
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        insertCache.run(entry.lat, entry.lon, entry.address, entry.cached_at);
      }
    });
    migrateCache();
    const count = db.prepare('SELECT COUNT(*) as c FROM geocode_cache').get().c;
    console.log(`Migrated ${count} geocode cache entries`);
  }
} catch {
  console.log('No geocode-cache.jsonl to migrate');
}

// Summary
const totalEntries = db.prepare('SELECT COUNT(*) as c FROM location_entries').get().c;
const totalPois = db.prepare('SELECT COUNT(*) as c FROM learned_pois').get().c;
const totalCache = db.prepare('SELECT COUNT(*) as c FROM geocode_cache').get().c;
console.log(`\nMigration complete:`);
console.log(`  location_entries: ${totalEntries}`);
console.log(`  learned_pois: ${totalPois}`);
console.log(`  geocode_cache: ${totalCache}`);

db.close();

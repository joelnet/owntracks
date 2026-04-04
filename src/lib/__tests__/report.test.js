import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db.js';
import { generateReport } from '../report.js';

function insertEntries(db, entries) {
  const stmt = db.prepare(`
    INSERT INTO location_entries (username, device, lat, lon, tst, acc, vel, type, received_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of entries) {
    stmt.run(
      e.username ?? 'test', e.device ?? 'phone',
      e.lat ?? null, e.lon ?? null, e.tst ?? null,
      e.acc ?? null, e.vel ?? null, e.type ?? 'location',
      e.received_at ?? new Date().toISOString(), JSON.stringify(e)
    );
  }
}

const baseConfig = {
  max_accuracy_m: 30,
  poi: {
    default_radius_m: 100,
    min_transition_points: 1,
    exit_extra_m: 0,
    locations: [
      { name: 'Home', lat: 34.017, lon: -117.903, radius_m: 100 },
    ],
  },
};

describe('generateReport', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
  });

  it('returns null for invalid date format', () => {
    assert.equal(generateReport('not-a-date', baseConfig, db, 'UTC'), null);
  });

  it('returns null when no data exists', () => {
    assert.equal(generateReport('2026-01-01', baseConfig, db, 'UTC'), null);
  });

  it('generates a report with timeline and location summary', () => {
    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 10 },
    ]);

    const report = generateReport('2026-03-20', baseConfig, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Location Report: 2026-03-20'));
    assert.ok(report.includes('Data points: 2'));
    assert.ok(report.includes('Day starts'));
    assert.ok(report.includes('Day ends'));
    assert.ok(report.includes('Home'));
    assert.ok(report.includes('Location Summary'));
  });

  it('filters low-accuracy entries', () => {
    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 50 },
    ]);

    const report = generateReport('2026-03-20', baseConfig, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Data points: 1'));
  });

  it('includes activity summary when activity is enabled', () => {
    const configWithActivity = {
      ...baseConfig,
      activity: {
        enabled: true,
        walking_max_kmh: 7,
        driving_min_kmh: 25,
        dwell_threshold_minutes: 5,
        window_size: 3,
        min_transition_seconds: 0,
        min_point_interval_seconds: 0,
      },
    };

    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 10 },
    ]);

    const report = generateReport('2026-03-20', configWithActivity, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Activity Summary'));
  });
});

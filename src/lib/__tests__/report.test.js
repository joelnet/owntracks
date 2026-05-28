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

  it('returns null for invalid date format', async () => {
    assert.equal(await generateReport('not-a-date', baseConfig, db, 'UTC'), null);
  });

  it('returns null when no data exists', async () => {
    assert.equal(await generateReport('2026-01-01', baseConfig, db, 'UTC'), null);
  });

  it('generates a report with timeline and location summary', async () => {
    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 10 },
    ]);

    const report = await generateReport('2026-03-20', baseConfig, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Location Report: 2026-03-20'));
    assert.ok(report.includes('Data points: 2'));
    assert.ok(report.includes('Day starts'));
    assert.ok(report.includes('Day ends'));
    assert.ok(report.includes('Home'));
    assert.ok(report.includes('Location Summary'));
  });

  it('filters low-accuracy entries', async () => {
    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 50 },
    ]);

    const report = await generateReport('2026-03-20', baseConfig, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Data points: 1'));
  });

  it('anchors day start to local midnight when first GPS point arrives mid-day', async () => {
    // Simulate user stationary at Home overnight — phone sends no updates until
    // midday. Day should still start at 12:00 AM at Home (seeded from prior day).
    const prevDay = Math.floor(new Date('2026-03-19T22:00:00Z').getTime() / 1000);
    const midDay = Math.floor(new Date('2026-03-20T19:08:00Z').getTime() / 1000); // 12:08 PM PDT
    const evening = Math.floor(new Date('2026-03-20T23:00:00Z').getTime() / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: prevDay, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: midDay, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: evening, acc: 10 },
    ]);

    const report = await generateReport('2026-03-20', baseConfig, db, 'America/Los_Angeles');
    assert.ok(report);
    assert.match(report, /12:00 AM\s+┌ Day starts — Home/);
    assert.match(report, /11:59 PM\s+└ Day ends — Home/);
    // Home should cover ~24h (allow for DST/rounding); definitely > 23h
    const homeMatch = report.match(/Home\s+(\d+)h/);
    assert.ok(homeMatch, 'Home duration should appear in summary');
    assert.ok(parseInt(homeMatch[1]) >= 23, `expected Home >= 23h, got ${homeMatch[1]}h`);
  });

  it('caps day end at "now" for today (not midnight of tomorrow)', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const t0 = Math.floor(Date.parse(today + 'T00:30:00Z') / 1000);

    insertEntries(db, [
      { type: 'location', lat: 34.017, lon: -117.903, tst: t0, acc: 10 },
    ]);

    const report = await generateReport(today, baseConfig, db, 'UTC');
    assert.ok(report);
    // For today, Day ends should not be 11:59 PM (we're not at end of day yet)
    assert.doesNotMatch(report, /11:59 PM\s+└ Day ends/);
  });

  it('includes activity summary when activity is enabled', async () => {
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

    const report = await generateReport('2026-03-20', configWithActivity, db, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Activity Summary'));
  });
});

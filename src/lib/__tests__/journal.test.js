import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db.js';
import { createJournal } from '../journal.js';

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

function tstAt(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

describe('journal', () => {
  let db;
  let dir;
  let config;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
    config = {
      max_accuracy_m: 30,
      distance_unit: 'miles',
      poi: {
        default_radius_m: 100,
        min_transition_points: 1,
        exit_extra_m: 0,
        locations: [
          { name: 'Home', lat: 34.017, lon: -117.903, radius_m: 100 },
        ],
      },
      journal: { enabled: true, dir, timezone: 'UTC' },
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes one from/to line per stay with duration', async () => {
    insertEntries(db, [
      // Prior-day seed so the day starts at Home, not Roaming
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-19T23:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T00:30:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T08:00:00Z'), acc: 10 },
      { lat: 34.030, lon: -117.903, tst: tstAt('2026-03-20T10:00:00Z'), acc: 10 },
      { lat: 34.031, lon: -117.903, tst: tstAt('2026-03-20T10:10:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T12:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T14:00:00Z'), acc: 10 },
    ]);

    const journal = createJournal({ config, db });
    const file = await journal.writeDay('2026-03-20');

    assert.equal(file, path.join(dir, '2026-03-20-location.md'));
    const md = fs.readFileSync(file, 'utf-8');

    assert.ok(md.startsWith('# Friday, March 20, 2026'));
    assert.ok(md.includes('- **Home** from 12:00 AM to 10:00 AM _(10h 0m)_'), md);
    assert.ok(md.includes('- **Home** from 12:00 PM to 11:59 PM _(11h 59m)_'), md);
    // Roaming gaps get no line; no arrive/leave chrome
    assert.ok(!md.includes('Roaming'));
    assert.ok(!md.includes('Left'));
    assert.ok(!md.includes('Arrived'));
    assert.ok(!md.includes('GPS points'));
  });

  it('omits places listed in journal.exclude', async () => {
    config.journal.exclude = ['Home'];
    config.poi.locations.push({ name: 'Work', lat: 33.635, lon: -117.850, radius_m: 100 });

    insertEntries(db, [
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-19T23:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T08:00:00Z'), acc: 10 },
      { lat: 33.635, lon: -117.850, tst: tstAt('2026-03-20T10:00:00Z'), acc: 10 },
      { lat: 33.635, lon: -117.850, tst: tstAt('2026-03-20T15:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T16:00:00Z'), acc: 10 },
    ]);

    const journal = createJournal({ config, db });
    const file = await journal.writeDay('2026-03-20');
    const md = fs.readFileSync(file, 'utf-8');

    assert.ok(md.includes('- **Work** from 10:00 AM to 4:00 PM _(6h 0m)_'), md);
    assert.ok(!md.includes('Home'), md);
  });

  it('describes an excluded baseline location when it lasted all day', async () => {
    config.journal.exclude = ['Home'];

    insertEntries(db, [
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-19T23:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T08:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T20:00:00Z'), acc: 10 },
    ]);

    const journal = createJournal({ config, db });
    const file = await journal.writeDay('2026-03-20');
    const md = fs.readFileSync(file, 'utf-8');

    assert.ok(md.includes('- At **Home** all day'), md);
    assert.ok(!md.includes('from 12:00 AM'), md);
  });

  it('renders the current stay as "since" while the day is in progress', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    insertEntries(db, [
      { lat: 34.017, lon: -117.903, tst: tstAt(today + 'T00:00:10Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt(today + 'T00:00:20Z'), acc: 10 },
    ]);

    const journal = createJournal({ config, db });
    const file = await journal.writeDay(today);
    const md = fs.readFileSync(file, 'utf-8');

    assert.match(md, /- \*\*Home\*\* since 12:00 AM _\(/, md);
    assert.ok(!md.includes('from 12:00 AM'));
  });

  it('summarizes walking/driving time and distance, omitting stationary', async () => {
    config.activity = {
      enabled: true,
      walking_max_kmh: 7,
      driving_min_kmh: 25,
      dwell_threshold_minutes: 5,
      window_size: 3,
      min_transition_seconds: 0,
      min_point_interval_seconds: 0,
    };

    // Stationary at Home all morning, then a fast drive north (~1.1 km/min).
    insertEntries(db, [
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T08:00:00Z'), acc: 10 },
      { lat: 34.030, lon: -117.903, tst: tstAt('2026-03-20T09:00:00Z'), acc: 10, vel: 60 },
      { lat: 34.040, lon: -117.903, tst: tstAt('2026-03-20T09:01:00Z'), acc: 10, vel: 60 },
      { lat: 34.050, lon: -117.903, tst: tstAt('2026-03-20T09:02:00Z'), acc: 10, vel: 60 },
      { lat: 34.060, lon: -117.903, tst: tstAt('2026-03-20T09:03:00Z'), acc: 10, vel: 60 },
      { lat: 34.070, lon: -117.903, tst: tstAt('2026-03-20T09:04:00Z'), acc: 10, vel: 60 },
    ]);

    const journal = createJournal({ config, db });
    const file = await journal.writeDay('2026-03-20');
    const md = fs.readFileSync(file, 'utf-8');

    assert.match(md, /- \*\*Driving:\*\* (\d+h )?\d+m · [\d.]+ mi/, md);
    assert.ok(!md.includes('Stationary'));
  });

  it('returns null and writes nothing when the day has no data', async () => {
    const journal = createJournal({ config, db });
    const file = await journal.writeDay('2026-01-01');
    assert.equal(file, null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('pushes Kuma only after a successful midnight finalization', async () => {
    config.journal.exclude = ['Home'];
    insertEntries(db, [
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-19T23:00:00Z'), acc: 10 },
      { lat: 34.017, lon: -117.903, tst: tstAt('2026-03-20T12:00:00Z'), acc: 10 },
    ]);

    const pushUrl = 'https://kuma.example/api/push/token?status=up&msg=OK&ping=';
    const calls = [];
    const fetchImpl = async (url) => {
      assert.ok(fs.existsSync(path.join(dir, '2026-03-20-location.md')));
      calls.push(url);
      return { ok: true, status: 200 };
    };
    const journal = createJournal({ config, db, kumaPushUrl: pushUrl, fetchImpl });

    const file = await journal.runMidnightFinalize('2026-03-21');

    assert.equal(file, path.join(dir, '2026-03-20-location.md'));
    assert.deepEqual(calls, [pushUrl]);
  });

  it('does not push Kuma when no journal file can be finalized', async () => {
    let pushed = false;
    const journal = createJournal({
      config,
      db,
      kumaPushUrl: 'https://kuma.example/api/push/token',
      fetchImpl: async () => { pushed = true; return { ok: true, status: 200 }; },
    });

    await assert.rejects(
      journal.runMidnightFinalize('2026-03-21'),
      /No location data for 2026-03-20/,
    );
    assert.equal(pushed, false);
  });
});

// Tuning regression suite.
//
// Drives the daily report end-to-end against the real `data/owntracks.db` for
// dates 2026-06-04 through 2026-06-15 and asserts the criteria captured in
// `data/tuning/criteria/*.md`. Good days lock the current baseline byte-for-byte;
// bad days assert the desired behaviour (currently failing) with a ±5 min
// tolerance, per `data/tuning/PLAN.md`.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { generateReport } from '../report.js';

const TZ = 'America/Los_Angeles';
const TOLERANCE_MIN = 5;
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'owntracks.db');
const BASELINE_DIR = path.join(ROOT, 'data', 'tuning', 'baseline');
const CONFIG_PATH = path.join(ROOT, 'config.yml');

// --- Shared fixture: real DB + config + learned POIs, loaded once. ---

let db;
let config;

before(() => {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  config = loadConfig(CONFIG_PATH);
  const learned = db.prepare('SELECT * FROM learned_pois').all();
  for (const poi of learned) config.poi.locations.push(poi);
});

after(() => {
  if (db) db.close();
});

async function reportFor(date) {
  const out = await generateReport(date, config, db, TZ);
  assert.ok(out, `report for ${date} was null`);
  return out;
}

// --- Event parser. ---
//
// Lines from report.js look like:
//   '12:00 AM    ┌ Day starts — Home (Stationary)'
//   '9:50 AM     │  → Driving'
//   '9:54 AM     ├ Left Home'
//   '10:35 AM    ├ Arrived at Work'
//   '11:32 AM    ├ Visited 123 Main St'
//   '11:59 PM    └ Day ends — Home (Stationary)'

const TIME_RE = /^(\d{1,2}):(\d{2})\s+(AM|PM)\s+/;

function parseEvents(report, dateStr) {
  const events = [];
  for (const line of report.split('\n')) {
    const m = line.match(TIME_RE);
    if (!m) continue;
    const [, hStr, mStr, ap] = m;
    let hour = parseInt(hStr, 10) % 12;
    if (ap === 'PM') hour += 12;
    const minute = parseInt(mStr, 10);
    const tst = localToEpoch(dateStr, hour, minute);
    const rest = line.slice(m[0].length);
    const ev = { tst, line, raw: rest };
    if (rest.includes('Day starts')) ev.type = 'start';
    else if (rest.includes('Day ends')) ev.type = 'end';
    else if (rest.includes('→')) {
      ev.type = 'activity';
      ev.state = rest.split('→')[1].trim().toUpperCase();
    } else if (rest.includes('Visited ')) ev.type = 'visit_started';
    else if (/Left .* \(\d+m visit\)/.test(rest)) ev.type = 'visit_ended';
    else if (rest.includes('Left ')) ev.type = 'left';
    else if (rest.includes('Arrived at ')) ev.type = 'arrived';
    events.push(ev);
  }
  return events;
}

function localToEpoch(dateStr, hour, minute) {
  // dateStr is YYYY-MM-DD in TZ. Convert local wall time to UTC tst.
  const utcGuess = Date.UTC(
    +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10),
    hour, minute, 0,
  );
  // Find TZ offset at that moment.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(utcGuess)).map(p => [p.type, p.value]),
  );
  const local = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second,
  );
  const offsetMs = local - utcGuess;
  return Math.floor((utcGuess - offsetMs) / 1000);
}

function nearTime(dateStr, hour, minute) {
  const target = localToEpoch(dateStr, hour, minute);
  return ev => Math.abs(ev.tst - target) <= TOLERANCE_MIN * 60;
}

function between(dateStr, h1, m1, h2, m2) {
  const a = localToEpoch(dateStr, h1, m1);
  const b = localToEpoch(dateStr, h2, m2);
  return ev => ev.tst >= a - TOLERANCE_MIN * 60 && ev.tst <= b + TOLERANCE_MIN * 60;
}

// --- Good-day snapshot tests (lock current baseline byte-for-byte). ---

const GOOD_DAYS = ['2026-06-06', '2026-06-09', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15'];

describe('good-day baselines (regression lock)', () => {
  for (const date of GOOD_DAYS) {
    it(`${date} matches baseline byte-for-byte`, async () => {
      const actual = (await reportFor(date)).trim();
      const expected = fs.readFileSync(path.join(BASELINE_DIR, `${date}.txt`), 'utf-8').trim();
      assert.equal(actual, expected,
        `Report drifted from baseline. To accept new output as the new lock, ` +
        `regenerate the baseline with: npm run report -- ${date} > data/tuning/baseline/${date}.txt`,
      );
    });
  }
});

// --- Bad-day acceptance criteria. ---
//
// Each `it()` asserts the *desired* behaviour. They are currently red.
// Phase 3's job is to make them green without breaking any good-day snapshot.

describe('2026-06-04 — 7-11 stop ~3:04 PM', () => {
  it('emits a Visited or Arrived event within ±5 min of 3:04 PM', async () => {
    const date = '2026-06-04';
    const events = parseEvents(await reportFor(date), date);
    const hit = events.find(e =>
      (e.type === 'visit_started' || e.type === 'arrived') &&
      nearTime(date, 15, 4)(e),
    );
    assert.ok(hit,
      `Expected a stop event near 3:04 PM. Got events near window:\n` +
      events.filter(between(date, 14, 55, 15, 15)).map(e => '  ' + e.line).join('\n'));
  });
});

describe('2026-06-05 — inbound trip from AMC ~10:35 PM', () => {
  it('emits a → Driving activity transition between 10:00 PM and 10:35 PM', async () => {
    const date = '2026-06-05';
    const events = parseEvents(await reportFor(date), date);
    const drove = events.find(e =>
      e.type === 'activity' && e.state === 'DRIVING' &&
      between(date, 22, 0, 22, 35)(e),
    );
    assert.ok(drove,
      `Expected a Driving transition during the inbound trip.\n` +
      events.filter(between(date, 21, 55, 22, 40)).map(e => '  ' + e.line).join('\n'));
  });

  it('emits a Left AMC event before Arrived at Home', async () => {
    const date = '2026-06-05';
    const events = parseEvents(await reportFor(date), date);
    const arrivedHome = events.find(e =>
      e.type === 'arrived' && e.raw.includes('Home') &&
      nearTime(date, 22, 35)(e),
    );
    const leftAmc = events.find(e =>
      (e.type === 'left' || e.type === 'visit_ended') &&
      /AMC/i.test(e.raw) &&
      between(date, 22, 0, 22, 35)(e),
    );
    assert.ok(arrivedHome, 'precondition: Arrived at Home near 10:35 PM should exist');
    assert.ok(leftAmc,
      `Expected a Left AMC event between 10:00 and 10:35 PM.\n` +
      events.filter(between(date, 21, 55, 22, 40)).map(e => '  ' + e.line).join('\n'));
  });
});

describe('2026-06-07A — arrival at Laverne Ave ~1:41 AM', () => {
  it('activity state immediately preceding the 1:41 AM arrival is Driving', async () => {
    const date = '2026-06-07';
    const events = parseEvents(await reportFor(date), date);
    const arrival = events.find(e =>
      e.type === 'arrived' && /Laverne/i.test(e.raw) && nearTime(date, 1, 41)(e),
    );
    assert.ok(arrival, 'precondition: Arrived at Laverne near 1:41 AM should exist');
    const preceding = events
      .filter(e => e.type === 'activity' && e.tst <= arrival.tst)
      .pop();
    assert.ok(preceding, 'expected an activity transition before the 1:41 AM arrival');
    assert.equal(preceding.state, 'DRIVING',
      `Expected activity=DRIVING before arrival. Got ${preceding.state} at line:\n  ${preceding.line}`);
  });
});

describe('2026-06-07B — afternoon return trip 4:39–5:48 PM', () => {
  it('has at most one activity transition between 4:39 PM and 5:48 PM (continuous Driving)', async () => {
    const date = '2026-06-07';
    const events = parseEvents(await reportFor(date), date);
    const transitions = events.filter(e =>
      e.type === 'activity' && between(date, 16, 39, 17, 48)(e),
    );
    assert.ok(transitions.length <= 1,
      `Expected at most one activity transition (continuous Driving). Got ${transitions.length}:\n` +
      transitions.map(e => '  ' + e.line).join('\n'));
  });
});

describe('2026-06-08 — Home Depot / Jersey Mike\'s midday trip', () => {
  it('emits at least one out-of-home event (Left Home, Visited, or Arrived non-Home) between 1:00 PM and 1:40 PM', async () => {
    const date = '2026-06-08';
    const events = parseEvents(await reportFor(date), date);
    const tripEvents = events.filter(e =>
      between(date, 13, 0, 13, 40)(e) &&
      (
        (e.type === 'left' && /Home/i.test(e.raw)) ||
        e.type === 'visit_started' ||
        (e.type === 'arrived' && !/Home/i.test(e.raw))
      ),
    );
    assert.ok(tripEvents.length > 0,
      `Expected at least one trip event between 1:00 PM and 1:40 PM. Got nothing in window. Full report:\n` +
      events.map(e => '  ' + e.line).join('\n'));
  });
});

describe('2026-06-10 — Driving transition vs Left Doshi alignment', () => {
  it('Driving transition and Left Doshi fire within ±5 min of each other', async () => {
    const date = '2026-06-10';
    const events = parseEvents(await reportFor(date), date);
    const leftDoshi = events.find(e => e.type === 'left' && /Doshi/i.test(e.raw));
    assert.ok(leftDoshi, 'precondition: a Left Doshi event should exist');
    const drove = events.filter(e =>
      e.type === 'activity' && e.state === 'DRIVING' &&
      Math.abs(e.tst - leftDoshi.tst) <= 60 * 60, // search ±60 min for a candidate
    );
    assert.ok(drove.length > 0, 'precondition: at least one Driving transition near Left Doshi');
    const closest = drove.reduce((a, b) =>
      Math.abs(a.tst - leftDoshi.tst) < Math.abs(b.tst - leftDoshi.tst) ? a : b,
    );
    const gapMin = Math.abs(closest.tst - leftDoshi.tst) / 60;
    assert.ok(gapMin <= TOLERANCE_MIN,
      `Driving transition and Left Doshi are ${gapMin.toFixed(1)} min apart (max ${TOLERANCE_MIN}).\n` +
      `  ${closest.line}\n  ${leftDoshi.line}`);
  });
});

describe('2026-06-11 — GameStop trip 5:30–5:55 PM', () => {
  it('emits a Visited event between 5:30 PM and 5:50 PM', async () => {
    const date = '2026-06-11';
    const events = parseEvents(await reportFor(date), date);
    const visited = events.find(e =>
      e.type === 'visit_started' && between(date, 17, 30, 17, 50)(e),
    );
    assert.ok(visited,
      `Expected a Visited event during the GameStop trip.\n` +
      events.filter(between(date, 17, 25, 17, 55)).map(e => '  ' + e.line).join('\n'));
  });

  it('day ends at Home (Stationary), not Roaming (Driving)', async () => {
    const date = '2026-06-11';
    const report = await reportFor(date);
    const endLine = report.split('\n').find(l => l.includes('Day ends'));
    assert.ok(endLine, 'precondition: a Day ends line should exist');
    assert.match(endLine, /Day ends — Home \(Stationary\)/,
      `Day should end at Home (Stationary). Got: ${endLine.trim()}`);
  });
});

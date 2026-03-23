#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createPOIDetector } from '../lib/poi.js';
import { createActivityDetector } from '../lib/activity.js';
import { loadConfig } from '../lib/config.js';

const TIMEZONE = process.env.TZ || 'America/Los_Angeles';

const date = process.argv[2]
  || new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: npm run report -- YYYY-MM-DD');
  process.exit(1);
}

const rootDir = path.join(import.meta.dirname, '..');
const config = loadConfig(path.join(rootDir, 'config.yml'));
const dataDir = path.join(rootDir, 'data');

// --- Helpers ---

function readJSONL(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function toLocalDate(tst) {
  return new Date(tst * 1000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function toLocalTime(tst) {
  return new Date(tst * 1000).toLocaleTimeString('en-US', {
    timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function adjacentDate(dateStr, offset) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// --- Load entries for the local date ---
// A local day can span up to 3 UTC-named files (prev, same, next)

const fileDates = [adjacentDate(date, -1), date, adjacentDate(date, 1)];
const allEntries = fileDates.flatMap(d => readJSONL(path.join(dataDir, `${d}.jsonl`)));

const maxAccuracy = config.max_accuracy_m;
const locationEntries = allEntries
  .filter(e => e.type === 'location' && typeof e.lat === 'number' && typeof e.lon === 'number')
  .filter(e => !maxAccuracy || typeof e.acc !== 'number' || e.acc <= maxAccuracy)
  .sort((a, b) => a.tst - b.tst);

const dayEntries = locationEntries.filter(e => toLocalDate(e.tst) === date);
const seedEntries = locationEntries.filter(e => e.tst < (dayEntries[0]?.tst ?? Infinity));

if (dayEntries.length === 0) {
  console.error(`No location data found for ${date}`);
  process.exit(1);
}

// --- Process through detectors ---

const poi = createPOIDetector(config);
const activity = config.activity?.enabled
  ? createActivityDetector(config.activity)
  : null;

// Seed with prior entries so state is correct at start of day
for (const e of seedEntries) {
  poi.detect(e.lat, e.lon);
  if (activity) activity.update(e.lat, e.lon, e.tst, e.vel);
}

const events = [];

events.push({
  tst: dayEntries[0].tst,
  type: 'start',
  location: poi.getLocation(),
  activity: activity?.getState() ?? 'N/A',
});

for (const e of dayEntries) {
  const poiResult = poi.detect(e.lat, e.lon);
  const actResult = activity?.update(e.lat, e.lon, e.tst, e.vel);

  if (poiResult.changed) {
    events.push({
      tst: e.tst,
      type: 'poi',
      location: poiResult.location,
      previousLocation: poiResult.previousLocation,
    });
  }

  if (actResult?.gapTransition) {
    events.push({
      tst: actResult.gapTransition.timestamp,
      type: 'activity',
      state: actResult.gapTransition.state,
      previousState: actResult.gapTransition.previousState,
    });
  }

  if (actResult && (actResult.changed || actResult.initialClassification)) {
    events.push({
      tst: e.tst,
      type: 'activity',
      state: actResult.state,
      previousState: actResult.previousState,
    });
  }
}

events.push({
  tst: dayEntries[dayEntries.length - 1].tst,
  type: 'end',
  location: poi.getLocation(),
  activity: activity?.getState() ?? 'N/A',
});

// Sort events chronologically (gap transitions have earlier timestamps)
events.sort((a, b) => a.tst - b.tst || (a.type === 'start' ? -1 : b.type === 'start' ? 1 : 0));

// --- Print timeline ---

console.log();
console.log(`Location Report: ${date}`);
console.log(`Timezone: ${TIMEZONE}  |  Data points: ${dayEntries.length}`);
console.log('='.repeat(50));
console.log();

for (const ev of events) {
  const time = toLocalTime(ev.tst).padEnd(10);

  switch (ev.type) {
    case 'start':
      console.log(`${time}  ┌ Day starts — ${ev.location} (${fmtState(ev.activity)})`);
      break;
    case 'poi':
      if (ev.location === 'Roaming') {
        console.log(`${time}  ├ Left ${ev.previousLocation}`);
      } else {
        console.log(`${time}  ├ Arrived at ${ev.location}`);
      }
      break;
    case 'activity':
      console.log(`${time}  │  → ${fmtState(ev.state)}`);
      break;
    case 'end':
      console.log(`${time}  └ Day ends — ${ev.location} (${fmtState(ev.activity)})`);
      break;
  }
}

function fmtState(s) {
  if (!s || s === 'N/A') return s;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// --- Location summary ---

console.log();
console.log('Location Summary');
console.log('-'.repeat(30));

const locationSpans = [];
let currentLoc = events[0].location;
let spanStart = dayEntries[0].tst;

for (const ev of events) {
  if (ev.type === 'poi') {
    locationSpans.push({ location: currentLoc, start: spanStart, end: ev.tst });
    currentLoc = ev.location;
    spanStart = ev.tst;
  }
}
locationSpans.push({ location: currentLoc, start: spanStart, end: dayEntries[dayEntries.length - 1].tst });

const totals = {};
for (const span of locationSpans) {
  totals[span.location] = (totals[span.location] || 0) + (span.end - span.start);
}

for (const [loc, secs] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${loc.padEnd(20)} ${formatDuration(secs)}`);
}
console.log();

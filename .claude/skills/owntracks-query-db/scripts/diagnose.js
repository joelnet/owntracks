#!/usr/bin/env node
// Diagnostic query for OwnTracks: dumps everything relevant to a time window
// so you can reason about why a visit/POI/activity event did or didn't fire.
//
// Usage:
//   node scripts/diagnose.js "2026-06-04 15:04 PDT"          # ±30 min window
//   node scripts/diagnose.js "2026-06-04T22:04:00Z" 60       # ±60 min window
//   node scripts/diagnose.js 1780610640 30                   # epoch seconds
//
// Run from the repo root (uses ./data/owntracks.db and ./config.yml).

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const TZ = 'America/Los_Angeles';

function parseWhen(arg) {
  if (/^\d+$/.test(arg)) return Number(arg);
  const d = new Date(arg);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Cannot parse time: ${arg}`);
  }
  return Math.floor(d.getTime() / 1000);
}

function fmt(ts) {
  const d = new Date(ts * 1000);
  const local = d.toLocaleString('en-US', { timeZone: TZ, hour12: false });
  return `${d.toISOString()}  (${local} ${TZ})`;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const arg = process.argv[2];
const windowMin = Number(process.argv[3] ?? 30);
if (!arg) {
  console.error('Usage: node scripts/diagnose.js <time> [windowMinutes]');
  process.exit(1);
}
const center = parseWhen(arg);
const start = center - windowMin * 60;
const end = center + windowMin * 60;

const config = parseYaml(readFileSync('config.yml', 'utf8'));
const maxAccuracy = config.max_accuracy_m;
const knownPois = [];
for (const p of config.poi?.locations ?? []) {
  const radius = p.radius_m ?? config.poi?.default_radius_m ?? 100;
  if (p.points) {
    for (const pt of p.points) {
      knownPois.push({ name: p.name, lat: pt.lat, lon: pt.lon, radius_m: pt.radius_m ?? radius });
    }
  } else {
    knownPois.push({ name: p.name, lat: p.lat, lon: p.lon, radius_m: radius });
  }
}

const db = new Database('data/owntracks.db', { readonly: true });

console.log(`Center:  ${fmt(center)}`);
console.log(`Window:  ±${windowMin} min  →  ${fmt(start)}  …  ${fmt(end)}`);
console.log(`Config:  max_accuracy_m=${maxAccuracy}  containment_radius_m=${config.visit_detection?.containment_radius_m}  min_dwell_minutes=${config.visit_detection?.min_dwell_minutes}  exit_timeout_minutes=${config.visit_detection?.exit_timeout_minutes}  min_distance_from_known_poi_m=${config.visit_detection?.min_distance_from_known_poi_m}`);
console.log();

const rows = db.prepare(
  'SELECT tst, lat, lon, acc, vel, type FROM location_entries WHERE tst BETWEEN ? AND ? ORDER BY tst'
).all(start, end);

console.log(`=== location_entries (${rows.length}) ===`);
console.log('  flags:  [SKIP] acc > max_accuracy_m   [POI:Name] inside a configured POI');
let prevTst = null;
for (const r of rows) {
  const gap = prevTst === null ? '' : ` Δ${(r.tst - prevTst).toFixed(0)}s`;
  const skip = (typeof r.acc === 'number' && r.acc > maxAccuracy) ? ' [SKIP]' : '';
  const hit = knownPois.find(p => haversine(p.lat, p.lon, r.lat, r.lon) <= p.radius_m);
  const tag = hit ? ` [POI:${hit.name}]` : '';
  const vel = r.vel === null ? 'null' : r.vel;
  console.log(`  ${fmt(r.tst)}  lat=${r.lat.toFixed(5)} lon=${r.lon.toFixed(5)} acc=${r.acc} vel=${vel}${gap}${skip}${tag}`);
  prevTst = r.tst;
}
console.log();

console.log('=== app_state (latest persisted snapshot — NOT a time-window query) ===');
const state = db.prepare('SELECT key, value, updated_at FROM app_state').all();
for (const s of state) {
  console.log(`  ${s.key}  (updated_at=${new Date(s.updated_at).toISOString()})`);
  try { console.log('   ', JSON.stringify(JSON.parse(s.value))); }
  catch { console.log('   ', s.value); }
}
console.log();

console.log('=== geocode_cache hits in window ===');
const geo = db.prepare(
  'SELECT lat, lon, address, cached_at FROM geocode_cache WHERE cached_at BETWEEN ? AND ?'
).all(start * 1000, end * 1000);
if (!geo.length) console.log('  (none — no reverse geocode happened in this window)');
for (const g of geo) {
  console.log(`  ${new Date(g.cached_at).toISOString()}  lat=${g.lat.toFixed(5)} lon=${g.lon.toFixed(5)}  ${g.address}`);
}
console.log();

console.log('=== nearest known POIs to window centroid ===');
if (rows.length) {
  const cx = rows.reduce((s, r) => s + r.lat, 0) / rows.length;
  const cy = rows.reduce((s, r) => s + r.lon, 0) / rows.length;
  const ranked = knownPois
    .map(p => ({ ...p, dist: haversine(p.lat, p.lon, cx, cy) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);
  console.log(`  centroid=(${cx.toFixed(5)}, ${cy.toFixed(5)})`);
  for (const p of ranked) {
    console.log(`  ${p.dist.toFixed(0)}m  ${p.name}  (radius ${p.radius_m}m)`);
  }
}

#!/usr/bin/env node

// Backfill vault journal notes from stored location data.
//
// Usage:
//   node src/scripts/backfill-journal.js              # past 7 days + today
//   node src/scripts/backfill-journal.js 14           # past N days + today
//   node src/scripts/backfill-journal.js 2026-07-14 2026-07-21   # date range

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDatabase, initSchema } from '../lib/db.js';
import { createJournal } from '../lib/journal.js';
import { adjacentDate } from '../lib/report.js';

const rootDir = path.join(import.meta.dirname, '..', '..');
const config = loadConfig(path.join(rootDir, 'config.yml'));

if (!config.journal?.enabled) {
  console.error('journal is not enabled in config.yml');
  process.exit(1);
}

const tz = config.journal.timezone || process.env.TZ || 'America/Los_Angeles';
const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const args = process.argv.slice(2);

let dates = [];
if (args.length === 2 && DATE_RE.test(args[0]) && DATE_RE.test(args[1])) {
  for (let d = args[0]; d <= args[1]; d = adjacentDate(d, 1)) {
    dates.push(d);
  }
} else if (args.length <= 1) {
  const days = args.length === 1 ? parseInt(args[0], 10) : 7;
  if (!Number.isInteger(days) || days < 0) {
    console.error('Usage: backfill-journal.js [days | YYYY-MM-DD YYYY-MM-DD]');
    process.exit(1);
  }
  for (let i = days; i >= 0; i--) {
    dates.push(adjacentDate(today, -i));
  }
} else {
  console.error('Usage: backfill-journal.js [days | YYYY-MM-DD YYYY-MM-DD]');
  process.exit(1);
}

const db = openDatabase();
initSchema(db);
const journal = createJournal({ config, db });

for (const date of dates) {
  const file = await journal.writeDay(date);
  console.log(file ? `wrote ${file}` : `no data for ${date}, skipped`);
}

db.close();

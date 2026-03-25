#!/usr/bin/env node

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { generateReport } from '../lib/report.js';

const TIMEZONE = process.env.TZ || 'America/Los_Angeles';

const date = process.argv[2]
  || new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: npm run report -- YYYY-MM-DD');
  process.exit(1);
}

const rootDir = path.join(import.meta.dirname, '..', '..');
const config = loadConfig(path.join(rootDir, 'config.yml'));
const dataDir = path.join(rootDir, 'data');

const report = generateReport(date, config, dataDir, TIMEZONE);

if (!report) {
  console.error(`No location data found for ${date}`);
  process.exit(1);
}

console.log();
console.log(report);
console.log();

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateReport } from '../report.js';

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
}

function writeJSONL(dir, filename, entries) {
  fs.writeFileSync(path.join(dir, filename), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
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
  let dataDir;

  beforeEach(() => {
    dataDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns null for invalid date format', () => {
    assert.equal(generateReport('not-a-date', baseConfig, dataDir, 'UTC'), null);
  });

  it('returns null when no data exists', () => {
    assert.equal(generateReport('2026-01-01', baseConfig, dataDir, 'UTC'), null);
  });

  it('generates a report with timeline and location summary', () => {
    // Two points at Home, 1 hour apart on 2026-03-20 UTC
    const tst1 = Math.floor(new Date('2026-03-20T10:00:00Z').getTime() / 1000);
    const tst2 = Math.floor(new Date('2026-03-20T11:00:00Z').getTime() / 1000);

    writeJSONL(dataDir, '2026-03-20.jsonl', [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 10 },
    ]);

    const report = generateReport('2026-03-20', baseConfig, dataDir, 'UTC');
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

    writeJSONL(dataDir, '2026-03-20.jsonl', [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 50 }, // over max_accuracy_m
    ]);

    const report = generateReport('2026-03-20', baseConfig, dataDir, 'UTC');
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

    writeJSONL(dataDir, '2026-03-20.jsonl', [
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst1, acc: 10 },
      { type: 'location', lat: 34.017, lon: -117.903, tst: tst2, acc: 10 },
    ]);

    const report = generateReport('2026-03-20', configWithActivity, dataDir, 'UTC');
    assert.ok(report);
    assert.ok(report.includes('Activity Summary'));
  });
});

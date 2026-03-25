import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEntry, getDataDir } from '../store.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../../data-test');

describe('store', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('creates a JSONL file named by date', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    assert.ok(fs.existsSync(filePath), 'JSONL file should exist');
  });

  it('writes valid JSON on each line', () => {
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const line = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.lat, 33.99);
    assert.equal(parsed.lon, -117.87);
    assert.equal(parsed.type, 'location');
  });

  it('appends multiple entries as separate lines', () => {
    const entry1 = { lat: 33.99, lon: -117.87, type: 'location' };
    const entry2 = { lat: 34.05, lon: -118.24, type: 'location' };
    appendEntry(entry1, TEST_DATA_DIR);
    appendEntry(entry2, TEST_DATA_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(TEST_DATA_DIR, `${today}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).lat, 33.99);
    assert.equal(JSON.parse(lines[1]).lat, 34.05);
  });

  it('creates data directory if it does not exist', () => {
    const nested = path.join(TEST_DATA_DIR, 'nested');
    const entry = { lat: 33.99, lon: -117.87, type: 'location' };
    appendEntry(entry, nested);
    assert.ok(fs.existsSync(nested), 'directory should be created');
  });
});

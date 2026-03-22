import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

const TMP_DIR = path.join(import.meta.dirname, '../../tmp-config-test');

function writeConfig(content) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, 'config.yml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const VALID_POI_SECTION = `
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0170901
      lon: -117.9025897
`;

describe('loadConfig', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('parses valid YAML with POI section', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0170901
      lon: -117.9025897
`);
    const config = loadConfig(filePath);
    assert.equal(config.poi.default_radius_m, 100);
    assert.equal(config.poi.locations.length, 1);
    assert.equal(config.poi.locations[0].name, 'Home');
    assert.equal(config.poi.locations[0].lat, 34.0170901);
    assert.equal(config.poi.locations[0].lon, -117.9025897);
  });

  it('throws on missing file', () => {
    assert.throws(() => loadConfig('/nonexistent/config.yml'), {
      message: /Cannot read config/,
    });
  });

  it('throws on malformed YAML (missing poi key)', () => {
    const filePath = writeConfig('something_else: true\n');
    assert.throws(() => loadConfig(filePath), {
      message: /must contain a "poi" object/,
    });
  });

  it('throws when default_radius_m is missing', () => {
    const filePath = writeConfig(`
poi:
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
`);
    assert.throws(() => loadConfig(filePath), {
      message: /default_radius_m.*positive number/,
    });
  });

  it('throws when locations is empty', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations: []
`);
    assert.throws(() => loadConfig(filePath), {
      message: /locations.*non-empty array/,
    });
  });

  it('throws when a location is missing required fields', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - lat: 34.0
      lon: -117.9
`);
    assert.throws(() => loadConfig(filePath), {
      message: /name.*string/,
    });
  });

  it('accepts optional per-POI radius_m override', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Work
      lat: 34.05
      lon: -118.24
      radius_m: 200
`);
    const config = loadConfig(filePath);
    assert.equal(config.poi.locations[0].radius_m, 200);
  });
});

describe('activity config', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('accepts valid config with activity section', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 7
  driving_min_kmh: 25
  window_size: 5
`);
    const config = loadConfig(filePath);
    assert.equal(config.activity.enabled, true);
    assert.equal(config.activity.walking_max_kmh, 7);
    assert.equal(config.activity.window_size, 5);
  });

  it('accepts config without activity section', () => {
    const filePath = writeConfig(VALID_POI_SECTION);
    const config = loadConfig(filePath);
    assert.equal(config.activity, undefined);
  });

  it('throws when enabled is not boolean', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
activity:
  enabled: "yes"
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 7
  driving_min_kmh: 25
  window_size: 5
`);
    assert.throws(() => loadConfig(filePath), { message: /enabled.*boolean/ });
  });

  it('throws when walking_max_kmh >= driving_min_kmh', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 25
  driving_min_kmh: 25
  window_size: 5
`);
    assert.throws(() => loadConfig(filePath), { message: /walking_max_kmh.*less than.*driving_min_kmh/ });
  });

  it('throws when window_size < 3', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 7
  driving_min_kmh: 25
  window_size: 2
`);
    assert.throws(() => loadConfig(filePath), { message: /window_size.*integer.*>= 3/ });
  });

  it('throws when a required field is missing', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
activity:
  enabled: true
`);
    assert.throws(() => loadConfig(filePath));
  });
});

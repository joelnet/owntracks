import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

const TMP_DIR = path.join(import.meta.dirname, '../../../tmp-config-test');

function writeConfig(content) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, 'config.yml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const VALID_VISIT_SECTION = `
visit_detection:
  enabled: true
  containment_radius_m: 200
  min_dwell_minutes: 5
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
`;

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

  it('accepts a POI with multiple anchor points', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      points:
        - lat: 34.0170901
          lon: -117.9025897
          radius_m: 100
        - lat: 34.019098
          lon: -117.901050
          radius_m: 50
`);
    const config = loadConfig(filePath);
    assert.equal(config.poi.locations[0].points.length, 2);
    assert.equal(config.poi.locations[0].points[1].radius_m, 50);
  });

  it('throws when points array is empty', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      points: []
`);
    assert.throws(() => loadConfig(filePath), { message: /points.*non-empty/ });
  });

  it('throws when a point has invalid lat', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      points:
        - lat: 999
          lon: -117.9
`);
    assert.throws(() => loadConfig(filePath), { message: /point lat/ });
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

describe('visit_detection config', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('accepts valid config with visit_detection section', () => {
    const filePath = writeConfig(VALID_POI_SECTION + VALID_VISIT_SECTION);
    const config = loadConfig(filePath);
    assert.equal(config.visit_detection.enabled, true);
    assert.equal(config.visit_detection.containment_radius_m, 200);
    assert.equal(config.visit_detection.min_dwell_minutes, 5);
    assert.equal(config.visit_detection.exit_timeout_minutes, 3);
    assert.equal(config.visit_detection.discord_notifications, true);
    assert.equal(config.visit_detection.learn_pois, true);
    assert.equal(config.visit_detection.learned_poi_radius_m, 100);
  });

  it('accepts config without visit_detection section', () => {
    const filePath = writeConfig(VALID_POI_SECTION);
    const config = loadConfig(filePath);
    assert.equal(config.visit_detection, undefined);
  });

  it('throws when enabled is not boolean', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
visit_detection:
  enabled: "yes"
  containment_radius_m: 200
  min_dwell_minutes: 5
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
`);
    assert.throws(() => loadConfig(filePath), { message: /visit_detection\.enabled.*boolean/ });
  });

  it('throws when containment_radius_m is not positive', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
visit_detection:
  enabled: true
  containment_radius_m: -1
  min_dwell_minutes: 5
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
`);
    assert.throws(() => loadConfig(filePath), { message: /containment_radius_m.*positive/ });
  });

  it('throws when min_dwell_minutes is not positive', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
visit_detection:
  enabled: true
  containment_radius_m: 200
  min_dwell_minutes: 0
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
`);
    assert.throws(() => loadConfig(filePath), { message: /min_dwell_minutes.*positive/ });
  });

  it('throws when exit_timeout_minutes is not positive', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
visit_detection:
  enabled: true
  containment_radius_m: 200
  min_dwell_minutes: 5
  exit_timeout_minutes: -1
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
`);
    assert.throws(() => loadConfig(filePath), { message: /exit_timeout_minutes.*positive/ });
  });

  it('throws when learned_poi_radius_m is not positive', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
visit_detection:
  enabled: true
  containment_radius_m: 200
  min_dwell_minutes: 5
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 0
`);
    assert.throws(() => loadConfig(filePath), { message: /learned_poi_radius_m.*positive/ });
  });
});

describe('geocode config', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('accepts valid config with geocode section', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
geocode:
  cache_radius_m: 100
`);
    const config = loadConfig(filePath);
    assert.equal(config.geocode.cache_radius_m, 100);
  });

  it('accepts config without geocode section', () => {
    const filePath = writeConfig(VALID_POI_SECTION);
    const config = loadConfig(filePath);
    assert.equal(config.geocode, undefined);
  });

  it('throws when cache_radius_m is not a positive number', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
geocode:
  cache_radius_m: 0
`);
    assert.throws(() => loadConfig(filePath), { message: /cache_radius_m.*positive/ });
  });

  it('throws when cache_radius_m is not a number', () => {
    const filePath = writeConfig(VALID_POI_SECTION + `
geocode:
  cache_radius_m: "big"
`);
    assert.throws(() => loadConfig(filePath), { message: /cache_radius_m.*positive/ });
  });
});

describe('poi.immediate_arrival_stationary_points', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('accepts a non-negative integer', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  immediate_arrival_stationary_points: 1
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
`);
    assert.equal(loadConfig(filePath).poi.immediate_arrival_stationary_points, 1);
  });

  it('rejects a negative or non-integer value', () => {
    for (const bad of ['-1', '1.5']) {
      const filePath = writeConfig(`
poi:
  default_radius_m: 100
  immediate_arrival_stationary_points: ${bad}
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
`);
      assert.throws(() => loadConfig(filePath), /immediate_arrival_stationary_points/);
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPOIDetector, haversineDistance } from '../poi.js';

const HOME = { name: 'Home', lat: 34.0170901, lon: -117.9025897 };
const NEAR_HOME = { lat: 34.0173, lon: -117.9026 };       // ~23m from Home
const FAR_AWAY = { lat: 34.0215, lon: -117.9026 };         // ~490m from Home

function makeConfig(locations, defaultRadius = 100) {
  return {
    poi: {
      default_radius_m: defaultRadius,
      locations,
    },
  };
}

describe('haversineDistance', () => {
  it('computes known distance between two real-world coordinates', () => {
    // Distance from (0, 0) to (0, 1) is ~111,195m (one degree of longitude at equator)
    const dist = haversineDistance(0, 0, 0, 1);
    assert.ok(dist > 111_000 && dist < 111_400, `Expected ~111,195m, got ${dist}`);
  });
});

describe('createPOIDetector', () => {
  it('returns correct POI name when point is inside radius', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.location, 'Home');
  });

  it('returns "Roaming" when point is outside all POIs', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.location, 'Roaming');
  });

  it('default state is Roaming — first detection while roaming returns changed: false', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.changed, false);
    assert.equal(result.location, 'Roaming');
  });

  it('first detection at a POI returns changed: true (Roaming → Home)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.changed, true);
    assert.equal(result.location, 'Home');
  });

  it('setLocation seeds state — subsequent matching detection returns changed: false', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.changed, false);
    assert.equal(result.location, 'Home');
  });

  it('changed is true on state transitions (Home → Roaming)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.changed, true);
    assert.equal(result.location, 'Roaming');
  });

  it('changed is true on state transitions (Roaming → Home)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    // Start roaming (default), then go far away (still Roaming, no change)
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    // Now arrive home
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.changed, true);
    assert.equal(result.location, 'Home');
  });

  it('changed is false for repeated same-location detections', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // Roaming → Home (changed)
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // Home → Home
    assert.equal(result.changed, false);
    assert.equal(result.location, 'Home');
  });

  it('per-POI radius_m override takes precedence over default_radius_m', () => {
    // Default radius 10m (too small to reach NEAR_HOME from HOME center)
    // But override with 200m on the POI
    const loc = { ...HOME, radius_m: 200 };
    const detector = createPOIDetector(makeConfig([loc], 10));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.location, 'Home');
  });

  it('when a point falls within multiple POI radii, first POI in config order wins', () => {
    const poi1 = { name: 'Office', lat: NEAR_HOME.lat, lon: NEAR_HOME.lon };
    const poi2 = { name: 'Home', lat: NEAR_HOME.lat, lon: NEAR_HOME.lon };
    const detector = createPOIDetector(makeConfig([poi1, poi2], 500));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.location, 'Office');
  });

  it('detect returns previousLocation on transition (Roaming → Home)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.previousLocation, 'Roaming');
  });

  it('detect returns previousLocation on transition (Home → Roaming)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.previousLocation, 'Home');
  });

  it('detect returns previousLocation matching location when no change', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.previousLocation, 'Roaming');
  });

  it('getLocation returns default Roaming state', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    assert.equal(detector.getLocation(), 'Roaming');
  });

  it('getLocation returns state after setLocation', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    assert.equal(detector.getLocation(), 'Home');
  });

  it('getLocation returns state after detect', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(detector.getLocation(), 'Home');
  });
});

describe('POI debounce (min_transition_points)', () => {
  function makeDebounceConfig(locations, points, defaultRadius = 100) {
    return {
      poi: { default_radius_m: defaultRadius, min_transition_points: points, locations },
    };
  }

  it('single point outside radius does not trigger departure with min_transition_points=3', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    detector.setLocation('Home');
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });

  it('transition fires after min_transition_points consecutive detections', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 1
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 2
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 3 → fires
    assert.equal(r.changed, true);
    assert.equal(r.location, 'Roaming');
    assert.equal(r.previousLocation, 'Home');
  });

  it('pending resets when a point matches confirmed location', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 1
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 2
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // back inside → resets pending
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending 1 again
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });

  it('arrival also requires min_transition_points', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    // Start roaming
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // pending 1
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // pending 2
    assert.equal(detector.getLocation(), 'Roaming');
    const r = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // pending 3 → fires
    assert.equal(r.changed, true);
    assert.equal(r.location, 'Home');
  });

  it('setLocation resets pending state', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending Roaming 1
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon); // pending Roaming 2
    detector.setLocation('Roaming'); // confirm Roaming, reset pending
    // Now detecting Home from Roaming needs 3 points
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon); // pending 1
    assert.equal(detector.getLocation(), 'Roaming');
  });

  it('defaults to min_transition_points=1 when not configured', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const r = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(r.changed, true);
    assert.equal(r.location, 'Home');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVisitDetector } from '../visit.js';

// Anchor point: a random location not near any known POI
const ANCHOR = { lat: 34.0500, lon: -117.9500 };
// ~50m from anchor (inside 200m containment)
const NEAR_ANCHOR = { lat: 34.0504, lon: -117.9500 };
// ~300m from anchor (outside 200m containment)
const FAR_FROM_ANCHOR = { lat: 34.0527, lon: -117.9500 };

const BASE_TST = 1711036800; // arbitrary start timestamp (seconds)

function makeConfig(overrides = {}) {
  return {
    containment_radius_m: 200,
    min_dwell_minutes: 5,
    exit_timeout_minutes: 3,
    learn_pois: false,
    learned_poi_radius_m: 100,
    ...overrides,
  };
}

function makePoint(lat, lon, tst) {
  return { lat, lon, tst };
}

// === Task 2: Session open ===

describe('createVisitDetector — session open', () => {
  it('opens session when roaming and not driving', () => {
    const v = createVisitDetector(makeConfig());
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().active, true);
  });

  it('opens session when roaming and walking', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'WALKING');
    assert.equal(v.getState().active, true);
  });

  it('opens session when roaming and unknown', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'UNKNOWN');
    assert.equal(v.getState().active, true);
  });

  it('does NOT open session when driving', () => {
    const v = createVisitDetector(makeConfig());
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'DRIVING');
    assert.equal(result, null);
    assert.equal(v.getState().active, false);
  });

  it('does NOT open session when at known POI', () => {
    const v = createVisitDetector(makeConfig());
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Home', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().active, false);
  });

  it('does NOT open second session when one is active', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 10), 'Roaming', 'STATIONARY');
    assert.equal(v.getState().point_count, 2);
  });

  it('sets anchor and centroid to first point', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const state = v.getState();
    assert.equal(state.anchor.lat, ANCHOR.lat);
    assert.equal(state.anchor.lon, ANCHOR.lon);
    assert.equal(state.centroid.lat, ANCHOR.lat);
    assert.equal(state.centroid.lon, ANCHOR.lon);
    assert.equal(state.point_count, 1);
  });
});

// === Task 2: Session close ===

describe('createVisitDetector — session close', () => {
  it('closes session when activity becomes DRIVING', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 60), 'Roaming', 'DRIVING');
    assert.equal(v.getState().active, false);
  });

  it('closes session when entering known POI', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 60), 'Home', 'STATIONARY');
    assert.equal(v.getState().active, false);
  });

  it('returns null on close if visit was not triggered', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 60), 'Roaming', 'DRIVING');
    assert.equal(result, null);
  });

  it('returns visit_ended on close if visit was triggered', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 600), 'Roaming', 'DRIVING');
    assert.equal(result.type, 'visit_ended');
    assert.ok(result.centroid.lat);
    assert.ok(result.centroid.lon);
    assert.ok(result.duration_minutes > 0);
  });
});

// === Task 2: Dwell trigger ===

describe('createVisitDetector — dwell trigger', () => {
  it('does NOT trigger before min_dwell_minutes elapsed', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 240), 'Roaming', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().triggered, false);
  });

  it('triggers visit_started after min_dwell_minutes elapsed', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(result.type, 'visit_started');
    assert.ok(result.centroid);
    assert.ok(result.started_at);
  });

  it('does NOT trigger twice in same session', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 600), 'Roaming', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().triggered, true);
  });

  it('updates centroid incrementally as points accumulate', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(34.0500, -117.9500, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(34.0504, -117.9500, BASE_TST + 60), 'Roaming', 'STATIONARY');
    const state = v.getState();
    assert.ok(Math.abs(state.centroid.lat - 34.0502) < 0.0001);
    assert.equal(state.point_count, 2);
  });
});

// === Task 3: Exit timeout ===

describe('createVisitDetector — exit timeout', () => {
  it('does NOT close session when briefly outside containment radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    assert.equal(result, null);
    assert.equal(v.getState().active, true);
  });

  it('closes session after exit_timeout_minutes outside containment', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60 + 181), 'Roaming', 'WALKING');
    assert.equal(v.getState().active, false);
  });

  it('resets outside timer when point returns inside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 120), 'Roaming', 'WALKING');
    assert.equal(v.getState().last_outside_at, null);
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 180), 'Roaming', 'WALKING');
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 300), 'Roaming', 'WALKING');
    assert.equal(result, null);
    assert.equal(v.getState().active, true);
  });

  it('untriggered session closed by exit timeout returns null', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 10), 'Roaming', 'WALKING');
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 10 + 181), 'Roaming', 'WALKING');
    assert.equal(result, null);
    assert.equal(v.getState().active, false);
  });

  it('triggered session closed by exit timeout returns visit_ended', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 400), 'Roaming', 'WALKING');
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 400 + 181), 'Roaming', 'WALKING');
    assert.equal(result.type, 'visit_ended');
    assert.ok(result.duration_minutes > 0);
  });
});

// === Task 3: GPS gaps ===

describe('createVisitDetector — GPS gaps', () => {
  it('session survives a GPS gap when next point is inside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 1800), 'Roaming', 'STATIONARY');
    assert.equal(v.getState().active, true);
  });

  it('session closes after gap when next point is outside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 1800), 'Roaming', 'WALKING');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 1800 + 181), 'Roaming', 'WALKING');
    assert.equal(v.getState().active, false);
  });
});

// === Task 3: New session after close ===

describe('createVisitDetector — new session after close', () => {
  it('can open a new session after previous one closes', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 60), 'Roaming', 'DRIVING');
    assert.equal(v.getState().active, false);
    v.processPoint(makePoint(34.0600, -117.9600, BASE_TST + 600), 'Roaming', 'STATIONARY');
    assert.equal(v.getState().active, true);
    assert.equal(v.getState().anchor.lat, 34.0600);
  });
});

// === Task 4: Learned POIs ===

describe('createVisitDetector — learned POIs', () => {
  it('creates a learned POI when visit triggers and learn_pois is true', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true }));
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    const pois = v.getLearnedPois();
    assert.equal(pois.length, 1);
    assert.ok(pois[0].name.startsWith('Unknown'));
    assert.equal(pois[0].radius_m, 100);
    assert.equal(pois[0].visit_count, 1);
  });

  it('does NOT create learned POI when learn_pois is false', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: false }));
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(v.getLearnedPois().length, 0);
  });

  it('deduplicates learned POIs within learned_poi_radius_m', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true }));
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 400), 'Roaming', 'DRIVING');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 1000), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 1301), 'Roaming', 'STATIONARY');
    const pois = v.getLearnedPois();
    assert.equal(pois.length, 1);
    assert.equal(pois[0].visit_count, 2);
  });

  it('creates separate learned POI for distant location', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true }));
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 400), 'Roaming', 'DRIVING');
    const farLat = 34.0700;
    v.processPoint(makePoint(farLat, ANCHOR.lon, BASE_TST + 1000), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(farLat, ANCHOR.lon, BASE_TST + 1301), 'Roaming', 'STATIONARY');
    const pois = v.getLearnedPois();
    assert.equal(pois.length, 2);
  });

  it('loadLearnedPois loads previously saved POIs', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true }));
    v.loadLearnedPois([
      { name: 'Saved Place', lat: 34.05, lon: -117.95, radius_m: 100, discovered_at: '2026-01-01T00:00:00Z', visit_count: 3, last_visited_at: '2026-03-01T00:00:00Z' },
    ]);
    const pois = v.getLearnedPois();
    assert.equal(pois.length, 1);
    assert.equal(pois[0].name, 'Saved Place');
    assert.equal(pois[0].visit_count, 3);
  });

  it('loadLearnedPois makes defensive copies', () => {
    const original = [{ name: 'Place', lat: 34.0, lon: -117.0, radius_m: 100, discovered_at: '', visit_count: 1, last_visited_at: '' }];
    const v = createVisitDetector(makeConfig());
    v.loadLearnedPois(original);
    original[0].name = 'Mutated';
    assert.equal(v.getLearnedPois()[0].name, 'Place');
  });

  it('rejects learned POI within min_distance_from_known_poi_m of a known POI', () => {
    // Known POI radius 100m + guard 200m = 300m exclusion. Anchor is ~259m from the known POI.
    const v = createVisitDetector(makeConfig({ learn_pois: true, min_distance_from_known_poi_m: 200 }));
    v.setKnownPois([{ name: 'Home', lat: 34.0170901, lon: -117.9025897, radius_m: 100 }]);
    const phantom = { lat: 34.019032, lon: -117.9010321 };
    v.processPoint(makePoint(phantom.lat, phantom.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(phantom.lat, phantom.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(v.getLearnedPois().length, 0);
  });

  it('learns POI farther than the guard distance from any known POI', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true, min_distance_from_known_poi_m: 200 }));
    v.setKnownPois([{ name: 'Home', lat: 34.0170901, lon: -117.9025897, radius_m: 100 }]);
    // ~1.5km from Home — well outside the 300m guard.
    v.processPoint(makePoint(34.0300, -117.9150, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(34.0300, -117.9150, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(v.getLearnedPois().length, 1);
  });

  it('suppresses visit_started/visit_ended when centroid is inside a known POI exclusion zone', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true, min_distance_from_known_poi_m: 200 }));
    v.setKnownPois([{ name: 'Home', lat: 34.0170901, lon: -117.9025897, radius_m: 100 }]);
    const phantom = { lat: 34.019032, lon: -117.9010321 }; // ~259m from Home, inside 100+200=300m guard
    const started = v.processPoint(makePoint(phantom.lat, phantom.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const triggered = v.processPoint(makePoint(phantom.lat, phantom.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    const ended = v.processPoint(makePoint(phantom.lat, phantom.lon, BASE_TST + 600), 'Home', 'STATIONARY');
    assert.equal(started, null);
    assert.equal(triggered, null, 'visit_started should be suppressed');
    assert.equal(ended, null, 'visit_ended should also be suppressed');
    assert.equal(v.getLearnedPois().length, 0);
  });

  it('guard disabled when min_distance_from_known_poi_m is 0', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true, min_distance_from_known_poi_m: 0 }));
    v.setKnownPois([{ name: 'Home', lat: ANCHOR.lat, lon: ANCHOR.lon, radius_m: 100 }]);
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(v.getLearnedPois().length, 1);
  });
});

// === Task 5: State persistence ===

describe('createVisitDetector — state persistence', () => {
  it('getState returns active: false when no session', () => {
    const v = createVisitDetector(makeConfig());
    assert.deepEqual(v.getState(), { active: false });
  });

  it('getState returns full session state during active session', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const state = v.getState();
    assert.equal(state.active, true);
    assert.equal(state.anchor.lat, ANCHOR.lat);
    assert.equal(state.centroid.lat, ANCHOR.lat);
    assert.equal(state.point_count, 1);
    assert.equal(state.triggered, false);
    assert.equal(state.last_outside_at, null);
    assert.ok(state.started_at);
  });

  it('restores active session from saved state', () => {
    const v1 = createVisitDetector(makeConfig());
    v1.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v1.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'STATIONARY');
    const savedState = v1.getState();
    const v2 = createVisitDetector(makeConfig(), savedState);
    const state = v2.getState();
    assert.equal(state.active, true);
    assert.equal(state.point_count, savedState.point_count);
    assert.equal(state.anchor.lat, savedState.anchor.lat);
    assert.equal(state.centroid.lat, savedState.centroid.lat);
  });

  it('restored session can still trigger', () => {
    const v1 = createVisitDetector(makeConfig());
    v1.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const savedState = v1.getState();
    const v2 = createVisitDetector(makeConfig(), savedState);
    const result = v2.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(result.type, 'visit_started');
  });

  it('ignores saved state with active: false', () => {
    const v = createVisitDetector(makeConfig(), { active: false });
    assert.equal(v.getState().active, false);
  });

  it('getState returns defensive copies', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    const state = v.getState();
    state.anchor.lat = 999;
    assert.equal(v.getState().anchor.lat, ANCHOR.lat);
  });
});

describe('createVisitDetector — learned POI tenants', () => {
  it('setLearnedPoiTenants round-trips through getLearnedPois', () => {
    const v = createVisitDetector(makeConfig());
    v.loadLearnedPois([{ name: 'Starbucks', lat: 34.017, lon: -117.903, radius_m: 100 }]);
    const tenants = [
      { name: 'Starbucks', visit_count: 1, last_selected_at: null },
      { name: 'Nail Salon', visit_count: 2, last_selected_at: '2026-07-23T18:00:00.000Z' },
    ];
    // Slightly drifted coordinates still match the anchor.
    v.setLearnedPoiTenants(34.0173, -117.9032, tenants);
    assert.deepEqual(v.getLearnedPois()[0].tenants, tenants);
  });

  it('setLearnedPoiTenants ignores coordinates matching no anchor', () => {
    const v = createVisitDetector(makeConfig());
    v.loadLearnedPois([{ name: 'Starbucks', lat: 34.017, lon: -117.903, radius_m: 100 }]);
    v.setLearnedPoiTenants(35.0, -118.0, [{ name: 'X', visit_count: 1 }]);
    assert.equal(v.getLearnedPois()[0].tenants, undefined);
  });
});

# Visit Detection & POI Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect visits to unknown locations using spatial containment + dwell time, trigger placeholder POI lookups, and auto-learn discovered POIs.

**Architecture:** A `createVisitDetector` factory (same pattern as `createActivityDetector` and `createPOIDetector`) processes GPS points alongside POI and activity results. It manages visit sessions with an anchor/centroid model, persists state to JSON, and stores learned POIs that get merged into the POI detector on startup.

**Tech Stack:** Node.js 18+, ESM modules, node:test runner, Haversine distance (from `poi.js`)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/visit.js` | Visit session detector — open/close sessions, containment check, dwell trigger, learned POI management |
| Create | `src/lib/__tests__/visit.test.js` | Unit tests for visit detector |
| Modify | `src/lib/config.js:59-71` | Add `visit_detection` section validation |
| Modify | `src/lib/__tests__/config.test.js` | Add tests for visit_detection config validation |
| Modify | `src/server.js:19,90-117,132-228` | Wire visit detector into pipeline and startup |
| Modify | `src/__tests__/server.test.js` | Add integration tests for visit detection |
| Modify | `config.yml` | Add `visit_detection` section |

---

### Task 1: Config Validation for visit_detection

**Files:**
- Modify: `src/lib/config.js:59-71`
- Modify: `src/lib/__tests__/config.test.js`

- [ ] **Step 1: Write failing tests for visit_detection config validation**

Add to `src/lib/__tests__/config.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/config.test.js`
Expected: New tests FAIL (visit_detection validation not implemented yet). Existing tests PASS.

- [ ] **Step 3: Add visit_detection validation to config.js**

Add the following block to `src/lib/config.js` after the activity config validation (after line 69), before `return config;`:

```javascript
  if (config.visit_detection !== undefined) {
    const { visit_detection } = config;
    if (typeof visit_detection.enabled !== 'boolean') throw new Error('visit_detection.enabled must be a boolean');
    if (typeof visit_detection.containment_radius_m !== 'number' || visit_detection.containment_radius_m <= 0) throw new Error('visit_detection.containment_radius_m must be a positive number');
    if (typeof visit_detection.min_dwell_minutes !== 'number' || visit_detection.min_dwell_minutes <= 0) throw new Error('visit_detection.min_dwell_minutes must be a positive number');
    if (typeof visit_detection.exit_timeout_minutes !== 'number' || visit_detection.exit_timeout_minutes <= 0) throw new Error('visit_detection.exit_timeout_minutes must be a positive number');
    if (typeof visit_detection.discord_notifications !== 'boolean') throw new Error('visit_detection.discord_notifications must be a boolean');
    if (typeof visit_detection.learn_pois !== 'boolean') throw new Error('visit_detection.learn_pois must be a boolean');
    if (typeof visit_detection.learned_poi_radius_m !== 'number' || visit_detection.learned_poi_radius_m <= 0) throw new Error('visit_detection.learned_poi_radius_m must be a positive number');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/config.test.js`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.js src/lib/__tests__/config.test.js
git commit -m "feat: add visit_detection config validation"
```

---

### Task 2: Visit Detector — Session Open, Close, and Dwell Trigger

**Files:**
- Create: `src/lib/visit.js`
- Create: `src/lib/__tests__/visit.test.js`

- [ ] **Step 1: Write failing tests for session open/close and dwell trigger**

Create `src/lib/__tests__/visit.test.js`:

```javascript
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

describe('createVisitDetector — session open', () => {
  it('opens session when roaming and not driving', () => {
    const v = createVisitDetector(makeConfig());
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    assert.equal(result, null); // no event on open
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
    // Second point at different location — should accumulate, not open new session
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
    // Fast-forward past dwell threshold (5 min = 300s)
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    // Now close by driving
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 600), 'Roaming', 'DRIVING');
    assert.equal(result.type, 'visit_ended');
    assert.ok(result.centroid.lat);
    assert.ok(result.centroid.lon);
    assert.ok(result.duration_minutes > 0);
  });
});

describe('createVisitDetector — dwell trigger', () => {
  it('does NOT trigger before min_dwell_minutes elapsed', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // 4 min later (below 5 min threshold)
    const result = v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 240), 'Roaming', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().triggered, false);
  });

  it('triggers visit_started after min_dwell_minutes elapsed', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // 5 min + 1s later
    const result = v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    assert.equal(result.type, 'visit_started');
    assert.ok(result.centroid);
    assert.ok(result.started_at);
  });

  it('does NOT trigger twice in same session', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    // Additional point after trigger
    const result = v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 600), 'Roaming', 'STATIONARY');
    assert.equal(result, null);
    assert.equal(v.getState().triggered, true);
  });

  it('updates centroid incrementally as points accumulate', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(34.0500, -117.9500, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(34.0504, -117.9500, BASE_TST + 60), 'Roaming', 'STATIONARY');
    const state = v.getState();
    // Mean of 34.0500 and 34.0504 = 34.0502
    assert.ok(Math.abs(state.centroid.lat - 34.0502) < 0.0001);
    assert.equal(state.point_count, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/visit.test.js`
Expected: FAIL — `visit.js` does not exist yet

- [ ] **Step 3: Implement visit detector core**

Create `src/lib/visit.js`:

```javascript
import { haversineDistance } from './poi.js';

export function createVisitDetector(config, savedState) {
  const {
    containment_radius_m,
    min_dwell_minutes,
    exit_timeout_minutes,
    learn_pois,
    learned_poi_radius_m,
  } = config;

  let session = null;
  let learnedPois = [];

  if (savedState && savedState.active) {
    session = {
      active: savedState.active,
      anchor: { ...savedState.anchor },
      centroid: { ...savedState.centroid },
      point_count: savedState.point_count,
      started_at: savedState.started_at,
      triggered: savedState.triggered,
      last_outside_at: savedState.last_outside_at,
    };
  }

  function openSession(lat, lon, tst) {
    session = {
      active: true,
      anchor: { lat, lon },
      centroid: { lat, lon },
      point_count: 1,
      started_at: new Date(tst * 1000).toISOString(),
      triggered: false,
      last_outside_at: null,
    };
  }

  function closeSession(tst) {
    if (!session) return null;
    const wasTriggered = session.triggered;
    let event = null;
    if (wasTriggered) {
      const startMs = new Date(session.started_at).getTime();
      const endMs = tst * 1000;
      const durationMin = Math.round((endMs - startMs) / 60000);
      event = {
        type: 'visit_ended',
        centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
        started_at: session.started_at,
        ended_at: new Date(endMs).toISOString(),
        duration_minutes: durationMin,
      };
    }
    session = null;
    return event;
  }

  function learnPoi(centroid, tst) {
    const now = new Date(tst * 1000).toISOString();
    const existing = learnedPois.find(p =>
      haversineDistance(p.lat, p.lon, centroid.lat, centroid.lon) <= learned_poi_radius_m
    );
    if (existing) {
      existing.visit_count++;
      existing.last_visited_at = now;
      existing.lat += (centroid.lat - existing.lat) / existing.visit_count;
      existing.lon += (centroid.lon - existing.lon) / existing.visit_count;
    } else {
      learnedPois.push({
        name: `Unknown (${centroid.lat.toFixed(4)}, ${centroid.lon.toFixed(4)})`,
        lat: centroid.lat,
        lon: centroid.lon,
        radius_m: learned_poi_radius_m,
        discovered_at: now,
        visit_count: 1,
        last_visited_at: now,
      });
    }
  }

  function processPoint(point, poiResult, activityState) {
    const { lat, lon, tst } = point;

    // Close conditions (checked before accumulation)
    if (session) {
      if (poiResult !== 'Roaming') return closeSession(tst);
      if (activityState === 'DRIVING') return closeSession(tst);
    }

    // Open condition
    if (!session && poiResult === 'Roaming' && activityState !== 'DRIVING') {
      openSession(lat, lon, tst);
      return null;
    }

    if (!session) return null;

    // During session: check containment
    const dist = haversineDistance(lat, lon, session.anchor.lat, session.anchor.lon);

    if (dist <= containment_radius_m) {
      session.last_outside_at = null;
      session.point_count++;
      session.centroid.lat += (lat - session.centroid.lat) / session.point_count;
      session.centroid.lon += (lon - session.centroid.lon) / session.point_count;

      if (!session.triggered) {
        const startMs = new Date(session.started_at).getTime();
        const elapsedSec = (tst * 1000 - startMs) / 1000;
        if (elapsedSec >= min_dwell_minutes * 60) {
          session.triggered = true;
          if (learn_pois) {
            learnPoi(session.centroid, tst);
          }
          return {
            type: 'visit_started',
            centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
            started_at: session.started_at,
          };
        }
      }
    } else {
      if (session.last_outside_at === null) {
        session.last_outside_at = new Date(tst * 1000).toISOString();
      }
      const outsideStartMs = new Date(session.last_outside_at).getTime();
      const outsideSec = (tst * 1000 - outsideStartMs) / 1000;
      if (outsideSec >= exit_timeout_minutes * 60) {
        return closeSession(tst);
      }
    }

    return null;
  }

  return {
    processPoint,
    getState() {
      if (!session) return { active: false };
      return {
        active: session.active,
        anchor: { lat: session.anchor.lat, lon: session.anchor.lon },
        centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
        point_count: session.point_count,
        started_at: session.started_at,
        triggered: session.triggered,
        last_outside_at: session.last_outside_at,
      };
    },
    getLearnedPois() {
      return learnedPois.map(p => ({ ...p }));
    },
    loadLearnedPois(pois) {
      learnedPois = pois.map(p => ({ ...p }));
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/visit.test.js`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/visit.js src/lib/__tests__/visit.test.js
git commit -m "feat: add visit detector with session open/close and dwell trigger"
```

---

### Task 3: Visit Detector — Exit Timeout and Edge Cases

**Files:**
- Modify: `src/lib/__tests__/visit.test.js`
- Modify: `src/lib/visit.js` (should already handle these — tests verify)

- [ ] **Step 1: Write tests for exit timeout and edge cases**

Append to `src/lib/__tests__/visit.test.js`:

```javascript
describe('createVisitDetector — exit timeout', () => {
  it('does NOT close session when briefly outside containment radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // Point outside radius but within exit timeout
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    assert.equal(result, null);
    assert.equal(v.getState().active, true);
  });

  it('closes session after exit_timeout_minutes outside containment', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // First point outside
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    // 3 min later, still outside
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60 + 181), 'Roaming', 'WALKING');
    assert.equal(v.getState().active, false);
  });

  it('resets outside timer when point returns inside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // Go outside
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 60), 'Roaming', 'WALKING');
    // Come back inside — should reset timer
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 120), 'Roaming', 'WALKING');
    assert.equal(v.getState().last_outside_at, null);
    // Go outside again — timeout starts fresh
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 180), 'Roaming', 'WALKING');
    // Only 2 min from new outside start — should NOT close
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 300), 'Roaming', 'WALKING');
    assert.equal(result, null);
    assert.equal(v.getState().active, true);
  });

  it('untriggered session closed by exit timeout returns null', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 10), 'Roaming', 'WALKING');
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 10 + 181), 'Roaming', 'WALKING');
    assert.equal(result, null); // not triggered, so no visit_ended event
    assert.equal(v.getState().active, false);
  });

  it('triggered session closed by exit timeout returns visit_ended', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // Trigger the visit
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    // Walk outside containment
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 400), 'Roaming', 'WALKING');
    // Exit timeout
    const result = v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 400 + 181), 'Roaming', 'WALKING');
    assert.equal(result.type, 'visit_ended');
    assert.ok(result.duration_minutes > 0);
  });
});

describe('createVisitDetector — GPS gaps', () => {
  it('session survives a GPS gap when next point is inside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // 30 min gap, next point still inside
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 1800), 'Roaming', 'STATIONARY');
    assert.equal(v.getState().active, true);
  });

  it('session closes after gap when next point is outside radius', () => {
    const v = createVisitDetector(makeConfig());
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    // 30 min gap, next point outside — the gap itself exceeds exit_timeout
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 1800), 'Roaming', 'WALKING');
    // Need another point beyond exit timeout from last_outside_at
    // Actually the first outside point sets last_outside_at, and it's the first outside point so
    // we need a second point to trigger the timeout comparison
    // OR: the gap means we set last_outside_at on this first outside point,
    // but outsideSec = 0 so it won't close yet. Need another point.
    v.processPoint(makePoint(FAR_FROM_ANCHOR.lat, FAR_FROM_ANCHOR.lon, BASE_TST + 1800 + 181), 'Roaming', 'WALKING');
    assert.equal(v.getState().active, false);
  });
});

describe('createVisitDetector — new session after close', () => {
  it('can open a new session after previous one closes', () => {
    const v = createVisitDetector(makeConfig());
    // First session
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 60), 'Roaming', 'DRIVING');
    assert.equal(v.getState().active, false);
    // New session at different location
    v.processPoint(makePoint(34.0600, -117.9600, BASE_TST + 600), 'Roaming', 'STATIONARY');
    assert.equal(v.getState().active, true);
    assert.equal(v.getState().anchor.lat, 34.0600);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/visit.test.js`
Expected: ALL tests PASS (the core implementation from Task 2 already handles these cases)

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/visit.test.js
git commit -m "test: add exit timeout and edge case tests for visit detector"
```

---

### Task 4: Visit Detector — Learned POI Management

**Files:**
- Modify: `src/lib/__tests__/visit.test.js`
- Modify: `src/lib/visit.js` (should already handle — tests verify)

- [ ] **Step 1: Write tests for learned POI creation and deduplication**

Append to `src/lib/__tests__/visit.test.js`:

```javascript
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
    // First visit
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    // Close session
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 400), 'Roaming', 'DRIVING');
    // Second visit at nearly same spot (within 100m)
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 1000), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(NEAR_ANCHOR.lat, NEAR_ANCHOR.lon, BASE_TST + 1301), 'Roaming', 'STATIONARY');
    const pois = v.getLearnedPois();
    assert.equal(pois.length, 1); // same POI, not a duplicate
    assert.equal(pois[0].visit_count, 2);
  });

  it('creates separate learned POI for distant location', () => {
    const v = createVisitDetector(makeConfig({ learn_pois: true }));
    // First visit
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 301), 'Roaming', 'STATIONARY');
    v.processPoint(makePoint(ANCHOR.lat, ANCHOR.lon, BASE_TST + 400), 'Roaming', 'DRIVING');
    // Second visit far away (>100m from first)
    const farLat = 34.0700; // ~2.2km from ANCHOR
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
    assert.equal(v.getLearnedPois()[0].name, 'Place'); // not mutated
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/visit.test.js`
Expected: ALL tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/visit.test.js
git commit -m "test: add learned POI management tests for visit detector"
```

---

### Task 5: Visit Detector — State Persistence

**Files:**
- Modify: `src/lib/__tests__/visit.test.js`

- [ ] **Step 1: Write tests for state save and restore**

Append to `src/lib/__tests__/visit.test.js`:

```javascript
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

    // Create new detector with saved state
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
    // Continue accumulating until dwell triggers
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
    assert.equal(v.getState().anchor.lat, ANCHOR.lat); // not mutated
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/visit.test.js`
Expected: ALL tests PASS

- [ ] **Step 3: Run full test suite to verify nothing is broken**

Run: `node --experimental-test-module-mocks --test`
Expected: ALL tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/__tests__/visit.test.js
git commit -m "test: add state persistence tests for visit detector"
```

---

### Task 6: Server Integration

**Files:**
- Modify: `src/server.js:19,90-117,132-228`
- Modify: `src/__tests__/server.test.js`

- [ ] **Step 1: Write failing integration tests**

Add to `src/__tests__/server.test.js`:

```javascript
  it('calls visit.processPoint on location entries when visit detector exists', async () => {
    const visitCalls = [];
    const visit = {
      processPoint: (point, poiResult, activityState) => {
        visitCalls.push({ point, poiResult, activityState });
        return null;
      },
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      visit,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(visitCalls.length, 1);
    assert.equal(visitCalls[0].point.lat, 34.05);
    assert.equal(visitCalls[0].poiResult, 'Roaming');
    assert.equal(visitCalls[0].activityState, 'STATIONARY');
  });

  it('sends Discord notification on visit_started event', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_started',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
      }),
      getState: () => ({ active: true }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg.includes('POI Lookup')));
  });

  it('sends Discord notification on visit_ended event', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_ended',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
        ended_at: '2026-03-29T15:15:00Z',
        duration_minutes: 45,
      }),
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'DRIVING',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: true },
      discord,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg.includes('Left unknown location') && msg.includes('45 min')));
  });

  it('does not send visit Discord notification when discord_notifications is false', async () => {
    const notified = [];
    const visit = {
      processPoint: () => ({
        type: 'visit_started',
        centroid: { lat: 34.0500, lon: -117.9500 },
        started_at: '2026-03-29T14:30:00Z',
      }),
      getState: () => ({ active: true }),
      getLearnedPois: () => [],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const discord = { notify: (msg) => notified.push(msg) };
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      visit,
      visitConfig: { discord_notifications: false },
      discord,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    const visitNotifications = notified.filter(msg => msg.includes('POI Lookup') || msg.includes('Left unknown'));
    assert.equal(visitNotifications.length, 0);
  });

  it('persists visit state via onVisitPersist callback', async () => {
    const persistCalls = [];
    const visit = {
      processPoint: () => null,
      getState: () => ({ active: true, anchor: { lat: 34.05, lon: -117.95 } }),
      getLearnedPois: () => [{ name: 'Test', lat: 34.05, lon: -117.95 }],
    };
    const detector = {
      detect: () => ({ changed: false, location: 'Roaming', previousLocation: 'Roaming' }),
      getLocation: () => 'Roaming',
    };
    const activity = {
      update: () => ({ changed: false, state: 'STATIONARY', previousState: 'STATIONARY', initialClassification: false }),
      getState: () => 'STATIONARY',
      getFullState: () => ({}),
    };
    const onVisitPersist = (state, pois) => persistCalls.push({ state, pois });
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      visit,
      onVisitPersist,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].state.active, true);
    assert.equal(persistCalls[0].pois.length, 1);
  });

  it('skips visit detection for non-location entries', async () => {
    const visitCalls = [];
    const visit = {
      processPoint: (point) => { visitCalls.push(point); return null; },
      getState: () => ({ active: false }),
      getLearnedPois: () => [],
    };
    const appWithVisit = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      visit,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.equal(visitCalls.length, 0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/__tests__/server.test.js`
Expected: New tests FAIL — `visit`, `visitConfig`, `onVisitPersist` not accepted by `createApp` yet

- [ ] **Step 3: Add visit detector integration to server.js**

In `src/server.js`, update the `createApp` function signature on line 19:

```javascript
export function createApp({ username, password, dataDir, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy } = {}) {
```

Add the visit detection block after the activity detection block (after line 117, before `appendEntry`):

```javascript
    // Visit detection
    if (
      visit &&
      entry.type === "location" &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const poiResult = detector ? detector.getLocation() : 'Roaming';
      const activityState = activity ? activity.getState() : 'UNKNOWN';
      const visitResult = visit.processPoint(
        { lat: entry.lat, lon: entry.lon, tst: entry.tst },
        poiResult,
        activityState
      );

      if (onVisitPersist) {
        try {
          onVisitPersist(visit.getState(), visit.getLearnedPois());
        } catch (err) {
          log.error(`Failed to persist visit state: ${err.message}`);
        }
      }

      if (visitResult && visitConfig?.discord_notifications && discord) {
        if (visitResult.type === 'visit_started') {
          discord.notify(`POI Lookup at (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)})`);
        }
        if (visitResult.type === 'visit_ended') {
          discord.notify(`Left unknown location (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)}) — ${visitResult.duration_minutes} min visit`);
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/__tests__/server.test.js`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/__tests__/server.test.js
git commit -m "feat: integrate visit detector into server pipeline"
```

---

### Task 7: Server Startup — Load Learned POIs and Visit State

**Files:**
- Modify: `src/server.js:132-228` (the `isDirectRun` block)

- [ ] **Step 1: Add visit detector initialization to startup block**

In `src/server.js`, add import at top (after line 11):

```javascript
import { createVisitDetector } from "./lib/visit.js";
```

In the `isDirectRun` block, add learned POI loading **before** `createPOIDetector` is called (after config loading, around line 143):

```javascript
  // Load learned POIs and merge into POI config before creating detector
  let learnedPois = [];
  const learnedPoisPath = path.join(import.meta.dirname, '..', 'data', 'learned-pois.json');
  if (config.visit_detection?.enabled && config.visit_detection?.learn_pois) {
    try {
      learnedPois = JSON.parse(fs.readFileSync(learnedPoisPath, 'utf-8'));
      for (const poi of learnedPois) {
        config.poi.locations.push(poi);
      }
      log.info(`Loaded ${learnedPois.length} learned POIs`);
    } catch {
      log.info('No learned POIs to load');
    }
  }
```

Then add visit detector initialization after the activity detector block (after line 225):

```javascript
  // Initialize visit detector (optional)
  let visit;
  let visitConfig;
  let onVisitPersist;
  if (config.visit_detection?.enabled) {
    visitConfig = config.visit_detection;

    const visitStatePath = path.join(import.meta.dirname, '..', 'data', 'visit-session.json');
    let savedVisitState = null;
    try {
      savedVisitState = JSON.parse(fs.readFileSync(visitStatePath, 'utf-8'));
      log.info(`Visit session restored: active=${savedVisitState.active}`);
    } catch {
      log.info('No visit session to restore');
    }

    visit = createVisitDetector(visitConfig, savedVisitState);
    visit.loadLearnedPois(learnedPois);

    onVisitPersist = (state, pois) => {
      const dir = path.join(import.meta.dirname, '..', 'data');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'visit-session.json'), JSON.stringify(state), 'utf-8');
      fs.writeFileSync(path.join(dir, 'learned-pois.json'), JSON.stringify(pois, null, 2), 'utf-8');
    };
  }
```

Update the `createApp` call (around line 228) to include the new parameters:

```javascript
  const app = createApp({ username, password, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy });
```

- [ ] **Step 2: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: ALL tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add visit detector startup with learned POI loading and state restore"
```

---

### Task 8: Config File Update

**Files:**
- Modify: `config.yml`

- [ ] **Step 1: Add visit_detection section to config.yml**

Append to `config.yml` after the activity section:

```yaml

visit_detection:
  enabled: true
  containment_radius_m: 200
  min_dwell_minutes: 5
  exit_timeout_minutes: 3
  discord_notifications: true
  learn_pois: true
  learned_poi_radius_m: 100
```

- [ ] **Step 2: Verify config loads without errors**

Run: `node -e "import('./src/lib/config.js').then(m => { m.loadConfig('config.yml'); console.log('OK'); })"`
Expected: `OK`

- [ ] **Step 3: Run full test suite one final time**

Run: `node --experimental-test-module-mocks --test`
Expected: ALL tests PASS

- [ ] **Step 4: Commit**

```bash
git add config.yml
git commit -m "feat: add visit_detection configuration"
```

# Activity Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a windowed activity state machine that classifies GPS points into UNKNOWN/STATIONARY/WALKING/DRIVING and sends Discord notifications on transitions.

**Architecture:** New `lib/activity.js` module using the same factory pattern as `lib/poi.js`. Sliding window of recent GPS points, median speed classification, dwell timer, debounce. State persisted to `data/activity-state.json`. Integrated into `server.js` POST handler after POI detection. Config validated in `lib/config.js`.

**Tech Stack:** Node.js (ES modules), node:test, assert/strict. No new dependencies — reuses `haversineDistance` from `lib/poi.js`.

**Spec:** `docs/superpowers/specs/2026-03-22-activity-detection-design.md`

---

### Task 1: Config Validation for Activity Section

**Files:**
- Modify: `lib/config.js`
- Test: `lib/__tests__/config.test.js`

- [ ] **Step 1: Write failing tests for activity config validation**

Add these tests to `lib/__tests__/config.test.js` inside a new `describe('activity config')` block:

```javascript
describe('activity config', () => {
  it('accepts valid config with activity section', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
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
    assert.equal(config.activity.window_size, 5);
  });

  it('accepts config without activity section', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
`);
    const config = loadConfig(filePath);
    assert.equal(config.activity, undefined);
  });

  it('throws when enabled is not boolean', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
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
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 30
  driving_min_kmh: 25
  window_size: 5
`);
    assert.throws(() => loadConfig(filePath), { message: /walking_max_kmh.*less than.*driving_min_kmh/ });
  });

  it('throws when window_size < 3', () => {
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
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
    const filePath = writeConfig(`
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0
      lon: -117.9
activity:
  enabled: true
`);
    assert.throws(() => loadConfig(filePath), { message: /discord_notifications.*boolean/ });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/config.test.js`
Expected: 6 new tests FAIL (activity validation not yet implemented)

- [ ] **Step 3: Implement activity config validation in loadConfig**

Add this to the end of `lib/config.js`, inside `loadConfig`, before `return config`:

```javascript
  if (config.activity !== undefined) {
    const { activity } = config;

    if (typeof activity.enabled !== 'boolean') {
      throw new Error('activity.enabled must be a boolean');
    }
    if (typeof activity.discord_notifications !== 'boolean') {
      throw new Error('activity.discord_notifications must be a boolean');
    }
    if (typeof activity.dwell_threshold_minutes !== 'number' || activity.dwell_threshold_minutes <= 0) {
      throw new Error('activity.dwell_threshold_minutes must be a positive number');
    }
    if (typeof activity.walking_max_kmh !== 'number' || activity.walking_max_kmh <= 0) {
      throw new Error('activity.walking_max_kmh must be a positive number');
    }
    if (typeof activity.driving_min_kmh !== 'number' || activity.driving_min_kmh <= 0) {
      throw new Error('activity.driving_min_kmh must be a positive number');
    }
    if (activity.walking_max_kmh >= activity.driving_min_kmh) {
      throw new Error('activity.walking_max_kmh must be less than activity.driving_min_kmh');
    }
    if (!Number.isInteger(activity.window_size) || activity.window_size < 3) {
      throw new Error('activity.window_size must be an integer >= 3');
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/config.test.js`
Expected: ALL pass (existing 7 + 6 new)

- [ ] **Step 5: Commit**

```bash
git add lib/config.js lib/__tests__/config.test.js
git commit -m "feat: add activity config validation"
```

---

### Task 2: Activity Detector — Core Module with Window and Median Speed

**Files:**
- Create: `lib/activity.js`
- Test: `lib/__tests__/activity.test.js`

- [ ] **Step 1: Write failing tests for window management and median speed**

Create `lib/__tests__/activity.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityDetector } from '../activity.js';

const BASE_CONFIG = {
  enabled: true,
  discord_notifications: true,
  dwell_threshold_minutes: 5,
  walking_max_kmh: 7,
  driving_min_kmh: 25,
  window_size: 3,
};

// Helper: generate a point at a given position, moving at a given speed.
// Each point is 30s apart, starting from baseTime.
// Speed in km/h. We place points along a line of longitude (north-south)
// at the equator so 1 degree lat ≈ 111,195m.
function makePoints(count, speedKmh, baseTime = 1000000) {
  const intervalSec = 30;
  const speedMs = speedKmh / 3.6; // m/s
  const distPerInterval = speedMs * intervalSec; // meters
  const degreesPerMeter = 1 / 111195; // approximate at equator
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: 0 + i * distPerInterval * degreesPerMeter,
      lon: 0,
      timestamp: baseTime + i * intervalSec,
      vel: speedKmh,
    });
  }
  return points;
}

describe('createActivityDetector', () => {
  describe('window management', () => {
    it('stays UNKNOWN until window is full', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(2, 30);
      const r1 = detector.update(p[0].lat, p[0].lon, p[0].timestamp, p[0].vel);
      assert.equal(r1.changed, false);
      assert.equal(detector.getState(), 'UNKNOWN');
      const r2 = detector.update(p[1].lat, p[1].lon, p[1].timestamp, p[1].vel);
      assert.equal(r2.changed, false);
      assert.equal(detector.getState(), 'UNKNOWN');
    });

    it('classifies on the window_size-th point', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(3, 30); // 30 km/h → DRIVING
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // After initial classification, state should no longer be UNKNOWN
      assert.notEqual(detector.getState(), 'UNKNOWN');
    });

    it('sorts window by timestamp for out-of-order points', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(3, 30);
      // Send in reverse order
      detector.update(p[2].lat, p[2].lon, p[2].timestamp, p[2].vel);
      detector.update(p[0].lat, p[0].lon, p[0].timestamp, p[0].vel);
      detector.update(p[1].lat, p[1].lon, p[1].timestamp, p[1].vel);
      // Should still classify correctly (not produce wild speeds)
      assert.notEqual(detector.getState(), 'UNKNOWN');
    });
  });

  describe('speed classification', () => {
    it('classifies high speed as DRIVING', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      // Need enough points to fill window + debounce (2 consecutive)
      const p = makePoints(5, 50); // 50 km/h
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');
    });

    it('classifies mid speed as WALKING', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 15); // 15 km/h — between 7 and 25
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'WALKING');
    });

    it('classifies low speed with enough dwell time as STATIONARY', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 0.01 }; // ~0.6s for test speed
      const detector = createActivityDetector(config);
      const p = makePoints(5, 0.5); // 0.5 km/h — below walking
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'STATIONARY');
    });
  });

  describe('vel handling', () => {
    it('treats null vel as 0 and uses calculated speed', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50);
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, null); // null vel
      }
      // Should still classify as DRIVING from calculated haversine speed
      assert.equal(detector.getState(), 'DRIVING');
    });

    it('treats negative vel as 0', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50);
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, -1);
      }
      assert.equal(detector.getState(), 'DRIVING');
    });
  });

  describe('zero timeDelta', () => {
    it('skips pairs with identical timestamps', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      // 3 points all at same timestamp — all pairs skipped
      const r1 = detector.update(0, 0, 1000, 50);
      const r2 = detector.update(0.001, 0, 1000, 50);
      const r3 = detector.update(0.002, 0, 1000, 50);
      // Window full but no valid pairs — should stay in current state
      assert.equal(r3.changed, false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/activity.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the core activity detector**

Create `lib/activity.js`:

```javascript
import { haversineDistance } from './poi.js';

function sanitizeVel(vel) {
  return typeof vel === 'number' && vel > 0 ? vel : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function createActivityDetector(config) {
  const {
    dwell_threshold_minutes,
    walking_max_kmh,
    driving_min_kmh,
    window_size,
  } = config;

  let window = [];
  let currentState = 'UNKNOWN';
  let dwellStart = null;
  let pendingState = null;
  let pendingCount = 0;

  function computeMedianSpeed() {
    const speeds = [];
    for (let i = 0; i < window.length - 1; i++) {
      const p1 = window[i];
      const p2 = window[i + 1];
      const timeDelta = p2.timestamp - p1.timestamp;
      if (timeDelta <= 0) continue;
      const dist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
      const calculatedKmh = (dist / timeDelta) * 3.6;
      const vel = sanitizeVel(p2.vel);
      speeds.push(Math.max(calculatedKmh, vel));
    }
    return speeds.length > 0 ? median(speeds) : null;
  }

  function classify(medianSpeed, timestamp) {
    if (medianSpeed >= driving_min_kmh) {
      dwellStart = null;
      return 'DRIVING';
    }
    if (medianSpeed >= walking_max_kmh) {
      dwellStart = null;
      return 'WALKING';
    }
    // Below walking speed — check dwell timer
    if (dwellStart === null) {
      dwellStart = timestamp;
    }
    if (timestamp - dwellStart >= dwell_threshold_minutes * 60) {
      return 'STATIONARY';
    }
    return 'WALKING';
  }

  return {
    update(lat, lon, timestamp, vel) {
      const point = { lat, lon, timestamp, vel };
      window.push(point);
      window.sort((a, b) => a.timestamp - b.timestamp);
      if (window.length > window_size) {
        window.shift();
      }

      if (window.length < window_size) {
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false };
      }

      const medianSpeed = computeMedianSpeed();
      if (medianSpeed === null) {
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false };
      }

      // Use the latest timestamp in the sorted window for dwell timer,
      // not the raw timestamp arg (which could be an old out-of-order point)
      const latestTimestamp = window[window.length - 1].timestamp;
      const candidate = classify(medianSpeed, latestTimestamp);

      // Debounce
      if (candidate === pendingState) {
        pendingCount++;
      } else {
        pendingState = candidate;
        pendingCount = 1;
      }

      // Initial classification (UNKNOWN → first real state)
      if (currentState === 'UNKNOWN' && pendingCount >= 2) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: false, state: currentState, previousState, initialClassification: true };
      }

      // Normal transition
      if (pendingCount >= 2 && pendingState !== currentState) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: true, state: currentState, previousState, initialClassification: false };
      }

      return { changed: false, state: currentState, previousState: currentState, initialClassification: false };
    },

    getState() {
      return currentState;
    },

    setState(savedState) {
      if (savedState && typeof savedState === 'object') {
        currentState = savedState.currentState || 'UNKNOWN';
        window = Array.isArray(savedState.window) ? savedState.window : [];
        dwellStart = savedState.dwellStart ?? null;
        pendingState = savedState.pendingState ?? null;
        pendingCount = savedState.pendingCount ?? 0;
      }
    },

    getFullState() {
      return { currentState, window, dwellStart, pendingState, pendingCount };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/activity.test.js`
Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add lib/activity.js lib/__tests__/activity.test.js
git commit -m "feat: add activity detector with windowed speed classification"
```

---

### Task 3: Activity Detector — Debounce, Initial Classification, and State Persistence

**Files:**
- Modify: `lib/__tests__/activity.test.js`
- (No code changes — these test existing behavior from Task 2)

- [ ] **Step 1: Write failing tests for debounce and state persistence**

Add these tests to `lib/__tests__/activity.test.js`:

```javascript
  describe('initial classification', () => {
    it('first classification returns changed: false and initialClassification: true', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50); // DRIVING
      let lastResult;
      for (const pt of p) {
        lastResult = detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // At some point during filling, the initial classification should have fired
      // The detector should now be DRIVING
      assert.equal(detector.getState(), 'DRIVING');
    });

    it('initial classification sets initialClassification flag', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50);
      const results = [];
      for (const pt of p) {
        results.push(detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel));
      }
      // Exactly one result should have initialClassification: true
      const initResults = results.filter(r => r.initialClassification);
      assert.equal(initResults.length, 1);
      assert.equal(initResults[0].changed, false);
    });
  });

  describe('state transitions', () => {
    it('transitions from DRIVING to WALKING with changed: true', () => {
      const detector = createActivityDetector({ ...BASE_CONFIG, window_size: 3 });
      // Establish DRIVING
      const driving = makePoints(5, 50, 1000000);
      for (const pt of driving) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');

      // Transition to WALKING (15 km/h, between 7 and 25)
      const walking = makePoints(5, 15, 1000200);
      let transitionResult = null;
      for (const pt of walking) {
        const r = detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
        if (r.changed) transitionResult = r;
      }
      assert.equal(detector.getState(), 'WALKING');
      assert.notEqual(transitionResult, null);
      assert.equal(transitionResult.changed, true);
      assert.equal(transitionResult.state, 'WALKING');
      assert.equal(transitionResult.previousState, 'DRIVING');
    });
  });

  describe('debounce', () => {
    it('single-point speed spike does not trigger transition', () => {
      const detector = createActivityDetector({ ...BASE_CONFIG, window_size: 3 });
      // Establish DRIVING state
      const driving = makePoints(5, 50, 1000000);
      for (const pt of driving) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');

      // Send one slow point (would be WALKING candidate) then back to fast
      const slowPoint = makePoints(1, 3, 1000200);
      detector.update(slowPoint[0].lat, slowPoint[0].lon, slowPoint[0].timestamp, slowPoint[0].vel);
      assert.equal(detector.getState(), 'DRIVING'); // should not have changed

      const fastAgain = makePoints(2, 50, 1000230);
      for (const pt of fastAgain) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');
    });
  });

  describe('state persistence', () => {
    it('getFullState returns complete internal state', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50);
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      const state = detector.getFullState();
      assert.equal(state.currentState, 'DRIVING');
      assert.equal(Array.isArray(state.window), true);
      assert.equal(state.window.length, BASE_CONFIG.window_size);
      assert.equal(typeof state.pendingCount, 'number');
    });

    it('setState + getFullState round-trip preserves state', () => {
      const detector1 = createActivityDetector(BASE_CONFIG);
      const p = makePoints(5, 50);
      for (const pt of p) {
        detector1.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      const saved = detector1.getFullState();

      const detector2 = createActivityDetector(BASE_CONFIG);
      detector2.setState(saved);
      assert.deepEqual(detector2.getFullState(), saved);
    });

    it('setState with null/invalid starts fresh', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      detector.setState(null);
      assert.equal(detector.getState(), 'UNKNOWN');
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/activity.test.js`
Expected: ALL pass (these test behavior already implemented in Task 2)

If any fail, fix the implementation in `lib/activity.js` to make them pass.

- [ ] **Step 3: Commit**

```bash
git add lib/__tests__/activity.test.js
git commit -m "test: add debounce, initial classification, and state persistence tests"
```

---

### Task 4: Activity Detector — Dwell Timer

**Files:**
- Modify: `lib/__tests__/activity.test.js`

- [ ] **Step 1: Write failing tests for dwell timer behavior**

Add to `lib/__tests__/activity.test.js`:

```javascript
  describe('dwell timer', () => {
    it('does not go stationary before dwell threshold', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 10, window_size: 3 };
      const detector = createActivityDetector(config);
      // Send slow points for 5 min (below 10 min threshold)
      // 30s intervals × 12 points = 6 minutes
      const p = makePoints(12, 2, 1000000); // 2 km/h, below walking_max of 7
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // Should be WALKING, not STATIONARY (only 5.5 min, threshold is 10)
      assert.equal(detector.getState(), 'WALKING');
    });

    it('goes stationary after dwell threshold is met', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 2, window_size: 3 };
      const detector = createActivityDetector(config);
      // Send slow points for 4 min (above 2 min threshold)
      // 30s intervals × 10 points = 4.5 minutes
      const p = makePoints(10, 1, 1000000); // 1 km/h
      for (const pt of p) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      assert.equal(detector.getState(), 'STATIONARY');
    });

    it('resets dwell timer when speed rises above walking threshold', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 2, window_size: 3 };
      const detector = createActivityDetector(config);
      // Slow for 1 min (below threshold)
      const slow1 = makePoints(4, 1, 1000000); // 1.5 min
      for (const pt of slow1) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // Fast burst — resets dwell timer
      const fast = makePoints(4, 15, 1000120);
      for (const pt of fast) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // Slow again for 1 min (below threshold again, timer restarted)
      const slow2 = makePoints(4, 1, 1000240);
      for (const pt of slow2) {
        detector.update(pt.lat, pt.lon, pt.timestamp, pt.vel);
      }
      // Should be WALKING, not STATIONARY (timer was reset)
      assert.notEqual(detector.getState(), 'STATIONARY');
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/activity.test.js`
Expected: ALL pass (dwell timer was implemented in Task 2)

If any fail, fix the implementation in `lib/activity.js`.

- [ ] **Step 3: Commit**

```bash
git add lib/__tests__/activity.test.js
git commit -m "test: add dwell timer tests for activity detection"
```

---

### Task 5: Add Activity Section to config.yml

**Files:**
- Modify: `config.yml`

- [ ] **Step 1: Add the activity section to config.yml**

Append to `config.yml`:

```yaml

activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 7
  driving_min_kmh: 25
  window_size: 5
```

- [ ] **Step 2: Run config tests to verify it's still valid**

Run: `node --experimental-test-module-mocks --test lib/__tests__/config.test.js`
Expected: ALL pass

- [ ] **Step 3: Commit**

```bash
git add config.yml
git commit -m "feat: add activity detection config to config.yml"
```

---

### Task 6: Integrate Activity Detection into server.js

**Files:**
- Modify: `server.js`
- Modify: `__tests__/server.test.js`

- [ ] **Step 1: Write failing tests for activity integration**

Add to `__tests__/server.test.js`, inside the `describe('POST /pub')` block:

```javascript
  it('calls activity.update on location entries when activity detector exists', async () => {
    const updateCalls = [];
    const activity = {
      update: (lat, lon, tst, vel) => {
        updateCalls.push({ lat, lon, tst, vel });
        return { changed: false, state: 'UNKNOWN', previousState: 'UNKNOWN', initialClassification: false };
      },
      getFullState: () => ({}),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 5 });
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].lat, 34.017);
    assert.equal(updateCalls[0].vel, 5);
  });

  it('skips activity detection for non-location entries', async () => {
    const updateCalls = [];
    const activity = {
      update: () => {
        updateCalls.push(true);
        return { changed: false, state: 'UNKNOWN', previousState: 'UNKNOWN', initialClassification: false };
      },
      getFullState: () => ({}),
    };
    const appWithActivity = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
    });
    await request(appWithActivity)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', event: 'enter', lat: 34.017, lon: -117.902, tst: 1711036800 });
    assert.equal(updateCalls.length, 0);
  });

  it('sends Discord notification on activity state change', async () => {
    const notified = [];
    const activity = {
      update: () => ({ changed: true, state: 'DRIVING', previousState: 'STATIONARY', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appWithActivityDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      discord,
      activityConfig: { discord_notifications: true },
    });
    await request(appWithActivityDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 50 });
    assert.ok(notified.some(m => m === 'Now Driving'));
  });

  it('does not send Discord notification when discord_notifications is false', async () => {
    const notified = [];
    const activity = {
      update: () => ({ changed: true, state: 'DRIVING', previousState: 'WALKING', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appNoNotify = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      discord,
      activityConfig: { discord_notifications: false },
    });
    await request(appNoNotify)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 50 });
    const activityNotifs = notified.filter(m => m.startsWith('Now '));
    assert.equal(activityNotifs.length, 0);
  });

  it('fires both POI and activity notifications on same point', async () => {
    const notified = [];
    const detector = {
      detect: () => ({ changed: true, location: 'Home', previousLocation: 'Roaming' }),
    };
    const activity = {
      update: () => ({ changed: true, state: 'DRIVING', previousState: 'WALKING', initialClassification: false }),
      getFullState: () => ({}),
    };
    const discord = {
      notify: (msg) => notified.push(msg),
    };
    const appBoth = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      activity,
      discord,
      activityConfig: { discord_notifications: true },
    });
    await request(appBoth)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 50 });
    assert.ok(notified.some(m => m === 'Arrived at Home'));
    assert.ok(notified.some(m => m === 'Now Driving'));
  });

  it('persists activity state on initialClassification', async () => {
    let persistedState = null;
    const activity = {
      update: () => ({ changed: false, state: 'DRIVING', previousState: 'UNKNOWN', initialClassification: true }),
      getFullState: () => ({ currentState: 'DRIVING', window: [] }),
    };
    const appWithPersist = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      activity,
      activityConfig: { discord_notifications: true },
      onActivityPersist: (state) => { persistedState = state; },
    });
    await request(appWithPersist)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, tst: 1711036800, vel: 50 });
    assert.deepEqual(persistedState, { currentState: 'DRIVING', window: [] });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test __tests__/server.test.js`
Expected: 5 new tests FAIL (activity integration not in server.js yet)

- [ ] **Step 3: Implement activity integration in server.js**

Modify `createApp` function signature to accept activity-related params:

```javascript
export function createApp({ username, password, dataDir, detector, discord, activity, activityConfig, onActivityPersist } = {}) {
```

Add this block in the POST handler, after the POI detection block (after line 80, before `appendEntry`):

```javascript
    // Activity detection
    if (
      activity &&
      entry.type === 'location' &&
      typeof entry.lat === 'number' &&
      typeof entry.lon === 'number'
    ) {
      const activityResult = activity.update(entry.lat, entry.lon, entry.tst, entry.vel);

      if (activityResult.changed || activityResult.initialClassification) {
        if (onActivityPersist) {
          try {
            onActivityPersist(activity.getFullState());
          } catch (err) {
            log.error(`Failed to persist activity state: ${err.message}`);
          }
        }
      }

      if (activityResult.changed && activityConfig?.discord_notifications && discord) {
        const stateName = activityResult.state.charAt(0) + activityResult.state.slice(1).toLowerCase();
        discord.notify(`Now ${stateName}`);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test __tests__/server.test.js`
Expected: ALL pass

- [ ] **Step 5: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: ALL pass

- [ ] **Step 6: Commit**

```bash
git add server.js __tests__/server.test.js
git commit -m "feat: integrate activity detection into POST handler"
```

---

### Task 7: Startup Wiring — State Recovery and Activity Detector Initialization

**Files:**
- Modify: `server.js` (the `isDirectRun` block)

- [ ] **Step 1: Add imports and startup wiring**

Add import at top of `server.js`:

```javascript
import { createActivityDetector } from "./lib/activity.js";
```

In the `isDirectRun` block, after the Discord initialization (after line 136), add:

```javascript
  // Initialize activity detector (optional)
  let activity;
  let activityConfig;
  let onActivityPersist;
  if (config.activity?.enabled) {
    activityConfig = config.activity;
    activity = createActivityDetector(activityConfig);

    // Restore persisted state
    const activityStatePath = path.join(import.meta.dirname, 'data', 'activity-state.json');
    try {
      const saved = JSON.parse(fs.readFileSync(activityStatePath, 'utf-8'));
      activity.setState(saved);
      log.info(`Activity state restored: ${saved.currentState}`);
    } catch {
      log.info('No activity state to restore — starting fresh');
    }

    onActivityPersist = (state) => {
      const dir = path.join(import.meta.dirname, 'data');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'activity-state.json'), JSON.stringify(state), 'utf-8');
    };
  }
```

Update the `createApp` call to pass the new params:

```javascript
  const app = createApp({ username, password, detector, discord, activity, activityConfig, onActivityPersist });
```

- [ ] **Step 2: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: ALL pass

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: wire up activity detector startup and state recovery"
```

---

### Task 8: Manual Smoke Test

- [ ] **Step 1: Verify config loads with activity section**

Run: `node -e "import('./lib/config.js').then(m => { const c = m.loadConfig('config.yml'); console.log('activity:', JSON.stringify(c.activity)); })"`
Expected: prints the activity config object

- [ ] **Step 2: Send test requests with curl**

Start the server, then send a sequence of location updates to verify activity detection works end-to-end. Check Discord for notifications.

```bash
# Use credentials from .env — replace with your actual values
# Stationary point
curl -s -X POST http://localhost:3000/pub \
  -H "Authorization: Basic $(echo -n "$OWNTRACKS_USERNAME:$OWNTRACKS_PASSWORD" | base64)" \
  -H "Content-Type: application/json" \
  -d '{"_type":"location","lat":34.017,"lon":-117.902,"tst":1000000,"vel":0}'

# Repeat with incrementing tst and varying vel to trigger state transitions
```

- [ ] **Step 3: Verify state persistence**

After sending enough points to trigger a state change, check that `data/activity-state.json` exists and contains valid state.

Run: `cat data/activity-state.json | python3 -m json.tool`

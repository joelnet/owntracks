# POI Drift Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent false "Left Home" Discord notifications caused by GPS drift by (1) resetting the POI detector's pending counter on filtered points and (2) requiring a minimum time span before POI transitions fire.

**Architecture:** Two changes to the POI detection pipeline. The POI detector (`poi.js`) gains a `resetPending()` method, a `pendingStartTime` timestamp, and a time-span gate on transitions. The server (`server.js`) calls `resetPending()` when filtering low-accuracy points, and passes `entry.tst` to `detect()`. Config adds `min_transition_seconds`.

**Tech Stack:** Node.js, node:test runner

---

### Task 1: Add `resetPending()` method and test

**Files:**
- Modify: `src/lib/poi.js:39-80`
- Test: `src/lib/__tests__/poi.test.js`

- [ ] **Step 1: Write the failing test**

Add a new describe block at the end of `src/lib/__tests__/poi.test.js`:

```js
describe('POI resetPending', () => {
  function makeDebounceConfig(locations, points, defaultRadius = 100) {
    return {
      poi: { default_radius_m: defaultRadius, min_transition_points: points, locations },
    };
  }

  it('resetPending clears accumulated pending count', () => {
    const detector = createPOIDetector(makeDebounceConfig([HOME], 3));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000); // pending 1
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1030); // pending 2
    detector.resetPending();
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1060); // pending 1 again (not 3)
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/poi.test.js`
Expected: FAIL — `detector.resetPending is not a function`

- [ ] **Step 3: Implement `resetPending()` in poi.js**

In `src/lib/poi.js`, add the `resetPending` method to the returned object (after the `resolveLocation` method at line 77):

```js
    resetPending() {
      pendingLocation = null;
      pendingCount = 0;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/poi.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/poi.js src/lib/__tests__/poi.test.js
git commit -m "feat: add resetPending() to POI detector"
```

---

### Task 2: Add `tst` parameter and `min_transition_seconds` time span gate

**Files:**
- Modify: `src/lib/poi.js:13-65`
- Test: `src/lib/__tests__/poi.test.js`

- [ ] **Step 1: Write failing tests for time span gate**

Add a new describe block at the end of `src/lib/__tests__/poi.test.js`:

```js
describe('POI min_transition_seconds', () => {
  function makeTimeConfig(locations, points, seconds, defaultRadius = 100) {
    return {
      poi: {
        default_radius_m: defaultRadius,
        min_transition_points: points,
        min_transition_seconds: seconds,
        locations,
      },
    };
  }

  it('does not transition when point count met but time span not met', () => {
    const detector = createPOIDetector(makeTimeConfig([HOME], 3, 300));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000); // pending 1
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1030); // pending 2
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1060); // pending 3, but only 60s elapsed
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });

  it('transitions when both point count and time span are met', () => {
    const detector = createPOIDetector(makeTimeConfig([HOME], 3, 300));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000);  // pending 1, pendingStartTime=1000
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1150);  // pending 2
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1300); // pending 3, 300s elapsed
    assert.equal(r.changed, true);
    assert.equal(r.location, 'Roaming');
    assert.equal(r.previousLocation, 'Home');
  });

  it('resets pendingStartTime when point matches current location', () => {
    const detector = createPOIDetector(makeTimeConfig([HOME], 3, 300));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000); // pending 1, startTime=1000
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1030); // pending 2
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon, 1060); // back home, resets
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1090); // pending 1, startTime=1090
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1120); // pending 2
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1300); // pending 3, but only 210s from 1090
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });

  it('resetPending also clears pendingStartTime', () => {
    const detector = createPOIDetector(makeTimeConfig([HOME], 3, 300));
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000); // pending 1, startTime=1000
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1030); // pending 2
    detector.resetPending(); // clear everything
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1060); // pending 1, startTime=1060
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1090); // pending 2
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1300); // pending 3, only 240s from 1060
    assert.equal(r.changed, false);
    assert.equal(r.location, 'Home');
  });

  it('defaults to no time gate when min_transition_seconds is not configured', () => {
    const detector = createPOIDetector({
      poi: { default_radius_m: 100, min_transition_points: 3, locations: [HOME] },
    });
    detector.setLocation('Home');
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1000);
    detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1030);
    const r = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon, 1060);
    assert.equal(r.changed, true);
    assert.equal(r.location, 'Roaming');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/poi.test.js`
Expected: New time-span tests FAIL (detect doesn't use tst yet, no time gate)

- [ ] **Step 3: Implement time span gate in poi.js**

Replace the `createPOIDetector` function body in `src/lib/poi.js` with the following. The changes are:
- Destructure `min_transition_seconds` from config (defaults to `0`)
- Add `pendingStartTime` state variable
- `detect()` signature becomes `detect(lat, lon, tst)`
- Set `pendingStartTime = tst` when `pendingCount` becomes 1
- Reset `pendingStartTime` alongside `pendingCount`
- Transition check becomes: count met AND (no time gate OR time span met)
- `resetPending()` also clears `pendingStartTime`

Full updated `src/lib/poi.js`:

```js
const EARTH_RADIUS_M = 6_371_008;

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createPOIDetector(config) {
  const { default_radius_m, locations, min_transition_points = 1, exit_extra_m = 0, min_transition_seconds = 0 } = config.poi;
  let lastLocation = 'Roaming';
  let pendingLocation = null;
  let pendingCount = 0;
  let pendingStartTime = null;

  function resolveLocation(lat, lon) {
    // Hysteresis: if currently at a POI, use larger exit radius for that POI
    if (lastLocation !== 'Roaming') {
      const currentPoi = locations.find(p => p.name === lastLocation);
      if (currentPoi) {
        const exitRadius = (currentPoi.radius_m ?? default_radius_m) + exit_extra_m;
        const dist = haversineDistance(lat, lon, currentPoi.lat, currentPoi.lon);
        if (dist <= exitRadius) return lastLocation;
      }
    }

    // Check entry into any POI using normal radius
    for (const poi of locations) {
      const radius = poi.radius_m ?? default_radius_m;
      const dist = haversineDistance(lat, lon, poi.lat, poi.lon);
      if (dist <= radius) return poi.name;
    }
    return 'Roaming';
  }

  return {
    detect(lat, lon, tst) {
      const current = resolveLocation(lat, lon);

      if (current === lastLocation) {
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        return { changed: false, location: lastLocation, previousLocation: lastLocation };
      }

      if (current === pendingLocation) {
        pendingCount++;
      } else {
        pendingLocation = current;
        pendingCount = 1;
        pendingStartTime = tst ?? null;
      }

      const countMet = pendingCount >= min_transition_points;
      const timeMet = min_transition_seconds === 0
        || pendingStartTime == null
        || tst == null
        || (tst - pendingStartTime) >= min_transition_seconds;

      if (countMet && timeMet) {
        const previousLocation = lastLocation;
        lastLocation = current;
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        return { changed: true, location: current, previousLocation };
      }

      return { changed: false, location: lastLocation, previousLocation: lastLocation };
    },

    setLocation(name) {
      lastLocation = name;
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
    },

    getLocation() {
      return lastLocation;
    },

    resolveLocation(lat, lon) {
      return resolveLocation(lat, lon);
    },

    resetPending() {
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
    },
  };
}
```

- [ ] **Step 4: Run all POI tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/__tests__/poi.test.js`
Expected: All tests PASS (existing tests still work because `tst` is optional and `min_transition_seconds` defaults to 0)

- [ ] **Step 5: Commit**

```bash
git add src/lib/poi.js src/lib/__tests__/poi.test.js
git commit -m "feat: add min_transition_seconds time span gate to POI detector"
```

---

### Task 3: Wire up server.js and update config

**Files:**
- Modify: `src/server.js:65-78`
- Modify: `config.yml`
- Test: `src/__tests__/server.test.js`

- [ ] **Step 1: Write failing server test for resetPending on filtered points**

Add to the end of the describe block in `src/__tests__/server.test.js`:

```js
  it('resets POI pending state when point is filtered by accuracy', async () => {
    let resetCalled = false;
    const detector = {
      detect: () => ({ changed: false, location: 'Home', previousLocation: 'Home' }),
      resetPending: () => { resetCalled = true; },
    };
    const appWithFilter = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      maxAccuracy: 30,
    });
    await request(appWithFilter)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, acc: 50, tst: 1711036800 });
    assert.equal(resetCalled, true);
  });

  it('does not reset POI pending state when point passes accuracy filter', async () => {
    let resetCalled = false;
    const detector = {
      detect: () => ({ changed: false, location: 'Home', previousLocation: 'Home' }),
      resetPending: () => { resetCalled = true; },
    };
    const appWithFilter = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      maxAccuracy: 30,
    });
    await request(appWithFilter)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.017, lon: -117.902, acc: 10, tst: 1711036800 });
    assert.equal(resetCalled, false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test src/__tests__/server.test.js`
Expected: FAIL — `resetPending` is not called (server.js doesn't call it yet)

- [ ] **Step 3: Update server.js**

Two changes in `src/server.js`:

**Change 1:** In the accuracy filter block (around line 65-70), call `detector.resetPending()` before the early return:

Replace:
```js
    // Skip low-accuracy GPS readings before any detection
    if (maxAccuracy && typeof entry.acc === 'number' && entry.acc > maxAccuracy) {
      appendEntry(entry, dataDir);
      log.info(`Entry saved (skipped detection, acc=${entry.acc}): user=${user} device=${device} type=${entry.type}`);
      return res.status(200).json([]);
    }
```

With:
```js
    // Skip low-accuracy GPS readings before any detection
    if (maxAccuracy && typeof entry.acc === 'number' && entry.acc > maxAccuracy) {
      if (detector) detector.resetPending();
      appendEntry(entry, dataDir);
      log.info(`Entry saved (skipped detection, acc=${entry.acc}): user=${user} device=${device} type=${entry.type}`);
      return res.status(200).json([]);
    }
```

**Change 2:** Pass `entry.tst` to `detector.detect()` (around line 78):

Replace:
```js
      const result = detector.detect(entry.lat, entry.lon);
```

With:
```js
      const result = detector.detect(entry.lat, entry.lon, entry.tst);
```

- [ ] **Step 4: Run server tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/__tests__/server.test.js`
Expected: All tests PASS

- [ ] **Step 5: Update config.yml**

Add `min_transition_seconds: 300` to the `poi` section of `config.yml`:

After the `exit_extra_m: 25` line, add:
```yaml
  min_transition_seconds: 300
```

- [ ] **Step 6: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/server.js src/__tests__/server.test.js config.yml
git commit -m "feat: reset POI pending on filtered points, add min_transition_seconds config"
```

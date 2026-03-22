# POI Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the user arrives at or departs from named POIs and log location transitions to a dedicated `logs/location.log` file.

**Architecture:** A `config.yml` defines POIs with lat/lon/radius. A POI detector uses Haversine distance to match incoming GPS coordinates against configured POIs and tracks state transitions. Location changes are written to a separate `logs/location.log` (not the daily app log). On startup, the last known location is recovered from `location.log`.

**Tech Stack:** Node.js ES modules, `yaml` npm package, Haversine formula (no geo library)

**Spec:** `docs/superpowers/specs/2026-03-22-poi-detection-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `config.yml` | POI configuration (name, lat, lon, radius) |
| `lib/config.js` | Load and validate `config.yml` at startup |
| `lib/poi.js` | Haversine distance + POI detector with state tracking |
| `lib/logger.js` | Modified — add `location()` writer for `logs/location.log` |
| `server.js` | Modified — load config, create detector, seed from logs, inject into app |
| `lib/__tests__/config.test.js` | Config loader tests |
| `lib/__tests__/poi.test.js` | POI detector tests |

---

### Task 1: Install `yaml` dependency and create `config.yml`

**Files:**
- Modify: `package.json`
- Create: `config.yml`

- [ ] **Step 1: Install yaml package**

Run: `npm install yaml`

- [ ] **Step 2: Create `config.yml`**

```yaml
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0170901
      lon: -117.9025897
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json config.yml
git commit -m "feat: add yaml dependency and config.yml with Home POI"
```

---

### Task 2: Config loader (`lib/config.js`) with TDD

**Files:**
- Create: `lib/__tests__/config.test.js`
- Create: `lib/config.js`

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/config.test.js`
Expected: FAIL — `loadConfig` does not exist yet

- [ ] **Step 3: Write minimal implementation**

```js
import fs from 'node:fs';
import YAML from 'yaml';

export function loadConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read config file: ${filePath}`);
  }

  const config = YAML.parse(raw);

  if (!config || typeof config.poi !== 'object' || config.poi === null) {
    throw new Error('Config must contain a "poi" object');
  }

  const { poi } = config;

  if (typeof poi.default_radius_m !== 'number' || poi.default_radius_m <= 0) {
    throw new Error('poi.default_radius_m must be a positive number');
  }

  if (!Array.isArray(poi.locations) || poi.locations.length === 0) {
    throw new Error('poi.locations must be a non-empty array');
  }

  for (const loc of poi.locations) {
    if (typeof loc.name !== 'string') {
      throw new Error('Each location must have a name (string)');
    }
    if (typeof loc.lat !== 'number' || loc.lat < -90 || loc.lat > 90) {
      throw new Error(`Location "${loc.name}": lat must be a number between -90 and 90`);
    }
    if (typeof loc.lon !== 'number' || loc.lon < -180 || loc.lon > 180) {
      throw new Error(`Location "${loc.name}": lon must be a number between -180 and 180`);
    }
    if (loc.radius_m !== undefined && (typeof loc.radius_m !== 'number' || loc.radius_m <= 0)) {
      throw new Error(`Location "${loc.name}": radius_m must be a positive number`);
    }
  }

  return config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/config.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/config.js lib/__tests__/config.test.js
git commit -m "feat: add config.yml loader with validation"
```

---

### Task 3: POI detector (`lib/poi.js`) with TDD

**Files:**
- Create: `lib/__tests__/poi.test.js`
- Create: `lib/poi.js`

- [ ] **Step 1: Write failing tests**

The Home POI is at `34.0170901, -117.9025897` with 100m radius. We need test coordinates:
- Inside home (~30m away): `34.0173, -117.9026`
- Outside home (~500m away): `34.0215, -117.9026`
- For Haversine accuracy, use a known reference: the distance from `0,0` to `0,1` is approximately 111,195 meters.

```js
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

});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

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
  const { default_radius_m, locations } = config.poi;
  let lastLocation = 'Roaming';

  return {
    detect(lat, lon) {
      let current = 'Roaming';
      for (const poi of locations) {
        const radius = poi.radius_m ?? default_radius_m;
        const dist = haversineDistance(lat, lon, poi.lat, poi.lon);
        if (dist <= radius) {
          current = poi.name;
          break;
        }
      }
      const changed = current !== lastLocation;
      lastLocation = current;
      return { changed, location: current };
    },

    setLocation(name) {
      lastLocation = name;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/poi.js lib/__tests__/poi.test.js
git commit -m "feat: add POI detector with Haversine geofencing"
```

---

### Task 4: Add location log writer to `lib/logger.js`

**Files:**
- Modify: `lib/logger.js:1-25`

- [ ] **Step 1: Add the `location()` export to `lib/logger.js`**

Add a `location()` function that writes to `logs/location.log` (single file, no daily rotation). Same timestamp format as `info()`/`error()`. Also echoes to console.

After the existing `error` export, add:

```js
const LOCATION_LOG = path.join(LOG_DIR, 'location.log');

export function location(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [INFO] ${message}`;
  fs.appendFileSync(LOCATION_LOG, line + '\n', 'utf-8');
  console.log(line);
}
```

Also export `LOCATION_LOG` path so `server.js` can read it for startup recovery:

```js
export const LOCATION_LOG_PATH = LOCATION_LOG;
```

- [ ] **Step 2: Run all existing tests to make sure nothing broke**

Run: `node --experimental-test-module-mocks --test`
Expected: All existing tests PASS (server tests mock logger, so new export is ignored)

- [ ] **Step 3: Commit**

```bash
git add lib/logger.js
git commit -m "feat: add location log writer for logs/location.log"
```

---

### Task 5: Integrate POI detection into `server.js`

**Files:**
- Modify: `server.js:1-90`

- [ ] **Step 1: Add detector parameter to `createApp` and add detection logic in handler**

Modify the `createApp` function signature to accept `detector`:

```js
export function createApp({ username, password, dataDir, detector } = {}) {
```

In the `POST /pub` handler, after building the `entry` object (line 56) and before `appendEntry` (line 58), add POI detection:

```js
    // POI detection
    if (detector && typeof entry.lat === 'number' && typeof entry.lon === 'number') {
      const result = detector.detect(entry.lat, entry.lon);
      if (result.changed) {
        log.location(`Location: ${result.location}`);
      }
    }
```

- [ ] **Step 2: Add startup config loading and state recovery in the `isDirectRun` block**

Replace the `isDirectRun` block with:

```js
if (isDirectRun) {
  const port = process.env.PORT || 3000;
  const username = process.env.OWNTRACKS_USERNAME;
  const password = process.env.OWNTRACKS_PASSWORD;

  if (!username || !password) {
    log.error('OWNTRACKS_USERNAME and OWNTRACKS_PASSWORD must be set in .env');
    process.exit(1);
  }

  // Load config and create POI detector
  const config = loadConfig(path.join(import.meta.dirname, 'config.yml'));
  const detector = createPOIDetector(config);

  // Seed detector state from location log
  try {
    const logContent = fs.readFileSync(log.LOCATION_LOG_PATH, 'utf-8');
    const lines = logContent.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/Location: (.+)$/);
      if (match) {
        detector.setLocation(match[1]);
        log.location(`Last known location: ${match[1]}`);
        break;
      }
    }
  } catch {
    // No location log yet — default to Roaming
  }

  const app = createApp({ username, password, detector });
  const server = app.listen(port, () => {
    log.info(`Server started on port ${port}`);
  });

  process.once('SIGUSR2', () => {
    log.info('Server shutting down (nodemon restart)');
    server.close(() => process.kill(process.pid, 'SIGUSR2'));
  });
}
```

The complete import block at the top of `server.js` should be:

```js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { appendEntry } from './lib/store.js';
import * as log from './lib/logger.js';
import { loadConfig } from './lib/config.js';
import { createPOIDetector } from './lib/poi.js';
```

- [ ] **Step 3: Update server test mock and add lat/lon guard test**

In `__tests__/server.test.js`, replace line 6:

```js
mock.module('../lib/logger.js', { namedExports: { info() {}, error() {} } });
```

with a trackable mock:

```js
const locationCalls = [];
mock.module('../lib/logger.js', {
  namedExports: {
    info() {},
    error() {},
    location(msg) { locationCalls.push(msg); },
    LOCATION_LOG_PATH: '',
  },
});
```

Add `locationCalls.length = 0;` in the existing `beforeEach` block to reset between tests.

Then add this test inside the `describe('POST /pub')` block:

```js
  it('skips POI detection when lat/lon are missing from body', async () => {
    const detector = {
      detect: () => { throw new Error('should not be called'); },
    };
    const appWithDetector = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
    });
    const res = await request(appWithDetector)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'transition', event: 'enter', tst: 1711036800 });
    assert.equal(res.status, 200);
    assert.equal(locationCalls.length, 0);
  });
```

- [ ] **Step 4: Run all tests to verify nothing is broken**

Run: `node --experimental-test-module-mocks --test`
Expected: All existing tests PASS. Server tests don't pass a `detector`, so POI detection is skipped (guard clause). Logger is mocked, so `log.location` is a no-op.

- [ ] **Step 5: Commit**

```bash
git add server.js __tests__/server.test.js
git commit -m "feat: integrate POI detection into request handler with startup recovery"
```

---

### Task 6: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: All tests pass (config: 7, poi: 10, store: 4, server: 8 = 29 total)

- [ ] **Step 2: Manual smoke test**

Start the server and send a test request near Home. Use the credentials from your `.env` file:

```bash
source .env
node server.js &
curl -s -X POST http://localhost:3000/pub \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "${OWNTRACKS_USERNAME}:${OWNTRACKS_PASSWORD}" | base64)" \
  -H "X-Limit-D: test" \
  -d '{"_type":"location","lat":34.0171,"lon":-117.9026,"tst":1711036800}'
```

Expected console output includes: `Location: Home`
Expected: `logs/location.log` contains a line with `Location: Home`

Send a request far from Home:

```bash
curl -s -X POST http://localhost:3000/pub \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "${OWNTRACKS_USERNAME}:${OWNTRACKS_PASSWORD}" | base64)" \
  -H "X-Limit-D: test" \
  -d '{"_type":"location","lat":34.05,"lon":-118.24,"tst":1711036801}'
```

Expected console output includes: `Location: Roaming`

Send the same far-away request again — no new location log (unchanged).

Kill the server: `kill %1`

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke test"
```

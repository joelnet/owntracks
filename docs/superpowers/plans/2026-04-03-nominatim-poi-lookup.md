# Nominatim POI Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse geocode `visit_started` coordinates via OpenStreetMap Nominatim with a local JSONL cache.

**Architecture:** New `src/lib/geocode.js` module handles cache lookup (Haversine radius match against `data/geocode-cache.jsonl`) and Nominatim API calls. `server.js` calls it before sending the Discord notification. Config validation extended for the optional `geocode` section.

**Tech Stack:** Node.js built-in `fetch`, existing `haversineDistance` from `poi.js`, `node:test` + `node:assert`

---

### Task 1: Config validation for `geocode` section

**Files:**
- Modify: `src/lib/config.js:84` (add validation before closing `return`)
- Test: `src/lib/__tests__/config.test.js`

- [ ] **Step 1: Write failing tests for geocode config validation**

Add a new `describe` block at the end of `src/lib/__tests__/config.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/config.test.js`

Expected: The "accepts valid config with geocode section" test passes (config just passes through), but "throws when cache_radius_m is not a positive number" fails (no validation yet).

- [ ] **Step 3: Add geocode config validation**

In `src/lib/config.js`, add this block after the `visit_detection` validation (after line 84, before `return config;`):

```js
  if (config.geocode !== undefined) {
    const { geocode } = config;
    if (typeof geocode.cache_radius_m !== 'number' || geocode.cache_radius_m <= 0) throw new Error('geocode.cache_radius_m must be a positive number');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/config.test.js`

Expected: All tests pass, including the new `geocode config` describe block.

- [ ] **Step 5: Add geocode section to config.yml**

Append to the end of `config.yml`:

```yaml

geocode:
  cache_radius_m: 100
```

- [ ] **Step 6: Commit**

```bash
cd /home/joel/dev/owntracks
git add src/lib/config.js src/lib/__tests__/config.test.js config.yml
git commit -m "Add geocode config section with cache_radius_m validation"
```

---

### Task 2: `reverseGeocode` — Nominatim API call (no cache yet)

**Files:**
- Create: `src/lib/geocode.js`
- Create: `src/lib/__tests__/geocode.test.js`

- [ ] **Step 1: Write failing tests for Nominatim API call**

Create `src/lib/__tests__/geocode.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reverseGeocode } from '../geocode.js';

const TMP_DIR = path.join(import.meta.dirname, '../../../tmp-geocode-test');
const CACHE_FILE = path.join(TMP_DIR, 'geocode-cache.jsonl');

describe('reverseGeocode', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('Nominatim API', () => {
    it('returns display_name on successful response', async () => {
      global.fetch = async (url) => ({
        ok: true,
        json: async () => ({ display_name: 'Target, 1234 E Foothill Blvd, Azusa, CA 91702, United States' }),
      });
      const result = await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'Target, 1234 E Foothill Blvd, Azusa, CA 91702, United States');
    });

    it('returns null on non-200 response', async () => {
      global.fetch = async () => ({ ok: false, status: 429 });
      const result = await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, null);
    });

    it('returns null on network error', async () => {
      global.fetch = async () => { throw new Error('network failure'); };
      const result = await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, null);
    });

    it('returns null when display_name is missing from response', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ error: 'Unable to geocode' }),
      });
      const result = await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, null);
    });

    it('sends correct URL and User-Agent header', async () => {
      let capturedUrl;
      let capturedOptions;
      global.fetch = async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return { ok: true, json: async () => ({ display_name: 'Test Address' }) };
      };
      await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.ok(capturedUrl.includes('lat=34.0297'));
      assert.ok(capturedUrl.includes('lon=-117.919'));
      assert.ok(capturedUrl.includes('format=json'));
      assert.ok(capturedUrl.startsWith('https://nominatim.openstreetmap.org/reverse'));
      assert.equal(capturedOptions.headers['User-Agent'], 'owntracks-journal/1.0');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/geocode.test.js`

Expected: FAIL — `reverseGeocode` does not exist yet.

- [ ] **Step 3: Implement reverseGeocode (Nominatim only, no cache)**

Create `src/lib/geocode.js`:

```js
import fs from 'node:fs';
import { haversineDistance } from './poi.js';

export async function reverseGeocode(lat, lon, { cacheFile, cacheRadiusM }) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'owntracks-journal/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.display_name) return null;
    return data.display_name;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/geocode.test.js`

Expected: All 5 Nominatim API tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/joel/dev/owntracks
git add src/lib/geocode.js src/lib/__tests__/geocode.test.js
git commit -m "Add reverseGeocode with Nominatim API call"
```

---

### Task 3: `reverseGeocode` — JSONL cache read/write

**Files:**
- Modify: `src/lib/geocode.js`
- Modify: `src/lib/__tests__/geocode.test.js`

- [ ] **Step 1: Write failing tests for cache behavior**

Add a new `describe('cache')` block inside the existing `describe('reverseGeocode')` in `src/lib/__tests__/geocode.test.js`:

```js
  describe('cache', () => {
    it('returns cached address when within cache radius', async () => {
      let fetchCalled = false;
      global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ display_name: 'Should Not Be Used' }) }; };
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ lat: 34.0297, lon: -117.9190, address: 'Cached Address', cached_at: '2026-04-01T00:00:00Z' }) + '\n');
      const result = await reverseGeocode(34.0298, -117.9191, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'Cached Address');
      assert.equal(fetchCalled, false);
    });

    it('calls Nominatim on cache miss and appends to cache file', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'New Place, 456 Oak Ave' }),
      });
      const result = await reverseGeocode(34.0500, -117.9500, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'New Place, 456 Oak Ave');
      const lines = fs.readFileSync(CACHE_FILE, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const cached = JSON.parse(lines[0]);
      assert.equal(cached.lat, 34.05);
      assert.equal(cached.lon, -117.95);
      assert.equal(cached.address, 'New Place, 456 Oak Ave');
      assert.ok(cached.cached_at);
    });

    it('does not write to cache on Nominatim failure', async () => {
      global.fetch = async () => ({ ok: false, status: 500 });
      await reverseGeocode(34.0500, -117.9500, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(fs.existsSync(CACHE_FILE), false);
    });

    it('returns nearest cached entry when multiple are within radius', async () => {
      global.fetch = async () => { throw new Error('should not call'); };
      const far = JSON.stringify({ lat: 34.0290, lon: -117.9190, address: 'Farther Place', cached_at: '2026-04-01T00:00:00Z' });
      const near = JSON.stringify({ lat: 34.0297, lon: -117.9190, address: 'Nearest Place', cached_at: '2026-04-01T00:00:00Z' });
      fs.writeFileSync(CACHE_FILE, far + '\n' + near + '\n');
      const result = await reverseGeocode(34.0297, -117.9190, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'Nearest Place');
    });

    it('handles missing cache file gracefully', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'Fresh Lookup' }),
      });
      const result = await reverseGeocode(34.0500, -117.9500, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'Fresh Lookup');
    });

    it('handles empty cache file gracefully', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'Fresh Lookup' }),
      });
      fs.writeFileSync(CACHE_FILE, '');
      const result = await reverseGeocode(34.0500, -117.9500, { cacheFile: CACHE_FILE, cacheRadiusM: 100 });
      assert.equal(result, 'Fresh Lookup');
    });
  });
```

- [ ] **Step 2: Run tests to verify cache tests fail**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/geocode.test.js`

Expected: Cache tests fail — no cache logic implemented yet. "returns cached address when within cache radius" will call fetch instead of returning cached value.

- [ ] **Step 3: Implement cache read/write in reverseGeocode**

Replace the contents of `src/lib/geocode.js` with:

```js
import fs from 'node:fs';
import { haversineDistance } from './poi.js';

function readCache(cacheFile) {
  try {
    const content = fs.readFileSync(cacheFile, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendCache(cacheFile, entry) {
  fs.appendFileSync(cacheFile, JSON.stringify(entry) + '\n');
}

export async function reverseGeocode(lat, lon, { cacheFile, cacheRadiusM }) {
  // Check cache first
  const entries = readCache(cacheFile);
  let nearest = null;
  let nearestDist = Infinity;
  for (const entry of entries) {
    const dist = haversineDistance(lat, lon, entry.lat, entry.lon);
    if (dist <= cacheRadiusM && dist < nearestDist) {
      nearest = entry;
      nearestDist = dist;
    }
  }
  if (nearest) return nearest.address;

  // Cache miss — call Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'owntracks-journal/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.display_name) return null;

    appendCache(cacheFile, {
      lat,
      lon,
      address: data.display_name,
      cached_at: new Date().toISOString(),
    });

    return data.display_name;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/lib/__tests__/geocode.test.js`

Expected: All 11 tests pass (5 Nominatim + 6 cache).

- [ ] **Step 5: Commit**

```bash
cd /home/joel/dev/owntracks
git add src/lib/geocode.js src/lib/__tests__/geocode.test.js
git commit -m "Add JSONL cache to reverseGeocode with radius-based lookup"
```

---

### Task 4: Integrate reverseGeocode into server.js

**Files:**
- Modify: `src/server.js:1-2` (add import), `src/server.js:20` (add `geocodeConfig` param), `src/server.js:144-147` (update visit_started handler)
- Modify: `src/__tests__/server.test.js` (update visit_started tests)

- [ ] **Step 1: Update existing visit_started test and add failure test**

In `src/__tests__/server.test.js`, update the existing `'sends Discord notification on visit_started event'` test (line 395) to pass the new `geocodeConfig` and a `reverseGeocode` mock. Also add a failure case.

Replace the test at line 395-432 with:

```js
  it('sends Discord notification on visit_started event with geocoded address', async () => {
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
      resolveLocation: () => 'Roaming',
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
      reverseGeocode: async () => 'Target, 1234 E Foothill Blvd, Azusa, CA',
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg === 'POI Lookup at Target, 1234 E Foothill Blvd, Azusa, CA'));
  });

  it('sends failure message when reverseGeocode returns null', async () => {
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
      resolveLocation: () => 'Roaming',
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
      reverseGeocode: async () => null,
    });
    await request(appWithVisit)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: 34.05, lon: -117.95, tst: 1711036800 });
    assert.ok(notified.some(msg => msg === 'POI Lookup failed for (34.0500, -117.9500)'));
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/__tests__/server.test.js`

Expected: The new "geocoded address" test fails because `createApp` doesn't accept `reverseGeocode` yet and still sends the old format.

- [ ] **Step 3: Update server.js to accept and use reverseGeocode**

In `src/server.js`, make these changes:

**a)** Update the `createApp` parameter destructuring (line 20) to include `reverseGeocode`:

```js
export function createApp({ username, password, dataDir, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode } = {}) {
```

**b)** Change the request handler from sync to async (line 25):

```js
  app.post("/pub", async (req, res) => {
```

**c)** Replace the `visit_started` handler (lines 145-147) with:

```js
        if (visitResult.type === 'visit_started') {
          const address = reverseGeocode
            ? await reverseGeocode(visitResult.centroid.lat, visitResult.centroid.lon)
            : null;
          if (address) {
            discord.notify(`POI Lookup at ${address}`);
          } else {
            discord.notify(`POI Lookup failed for (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)})`);
          }
        }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test src/__tests__/server.test.js`

Expected: All tests pass. The old `'does not send visit Discord notification when discord_notifications is false'` test still passes because it doesn't pass `reverseGeocode`, so the fallback message fires but is filtered out by the existing assertion.

- [ ] **Step 5: Run full test suite**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/joel/dev/owntracks
git add src/server.js src/__tests__/server.test.js
git commit -m "Integrate reverseGeocode into visit_started Discord notification"
```

---

### Task 5: Wire up reverseGeocode in server startup

**Files:**
- Modify: `src/server.js:167-312` (startup section — add import and wire config to `createApp`)

- [ ] **Step 1: Add import and wire reverseGeocode in startup**

In `src/server.js`:

**a)** Add import at the top (after line 12):

```js
import { reverseGeocode as nominatimGeocode } from "./lib/geocode.js";
```

**b)** In the startup section, before the `createApp` call (around line 311), build the bound geocode function. Add this before the `const app = createApp(...)` line:

```js
  // Build geocode function if configured
  let reverseGeocode;
  if (config.geocode) {
    const geocodeCacheFile = path.join(import.meta.dirname, '..', 'data', 'geocode-cache.jsonl');
    const geocodeCacheRadiusM = config.geocode.cache_radius_m;
    reverseGeocode = (lat, lon) => nominatimGeocode(lat, lon, { cacheFile: geocodeCacheFile, cacheRadiusM: geocodeCacheRadiusM });
  }
```

**c)** Add `reverseGeocode` to the `createApp` call (line 312):

```js
  const app = createApp({ username, password, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode });
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/joel/dev/owntracks && node --experimental-test-module-mocks --test`

Expected: All tests pass. The startup code only runs when executed directly, so tests are unaffected.

- [ ] **Step 3: Commit**

```bash
cd /home/joel/dev/owntracks
git add src/server.js
git commit -m "Wire Nominatim geocode into server startup with config"
```

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
});

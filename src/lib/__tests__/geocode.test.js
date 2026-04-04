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

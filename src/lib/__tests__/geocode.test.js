import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../db.js';
import { reverseGeocode } from '../geocode.js';

describe('reverseGeocode', () => {
  let originalFetch;
  let db;

  beforeEach(() => {
    originalFetch = global.fetch;
    db = new Database(':memory:');
    initSchema(db);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
  });

  describe('Nominatim API', () => {
    it('returns display_name on successful response', async () => {
      global.fetch = async (url) => ({
        ok: true,
        json: async () => ({ display_name: 'Target, 1234 E Foothill Blvd, Azusa, CA 91702, United States' }),
      });
      const result = await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
      assert.equal(result, 'Target, 1234 E Foothill Blvd, Azusa, CA 91702, United States');
    });

    it('returns null on non-200 response', async () => {
      global.fetch = async () => ({ ok: false, status: 429 });
      const result = await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
      assert.equal(result, null);
    });

    it('returns null on network error', async () => {
      global.fetch = async () => { throw new Error('network failure'); };
      const result = await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
      assert.equal(result, null);
    });

    it('returns null when display_name is missing from response', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ error: 'Unable to geocode' }),
      });
      const result = await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
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
      await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
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
      db.prepare('INSERT INTO geocode_cache (lat, lon, address, cached_at) VALUES (?, ?, ?, ?)').run(34.0297, -117.9190, 'Cached Address', '2026-04-01T00:00:00Z');
      const result = await reverseGeocode(34.0298, -117.9191, { db, cacheRadiusM: 100 });
      assert.equal(result, 'Cached Address');
      assert.equal(fetchCalled, false);
    });

    it('calls Nominatim on cache miss and appends to cache file', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'New Place, 456 Oak Ave' }),
      });
      const result = await reverseGeocode(34.0500, -117.9500, { db, cacheRadiusM: 100 });
      assert.equal(result, 'New Place, 456 Oak Ave');
      const rows = db.prepare('SELECT * FROM geocode_cache').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].lat, 34.05);
      assert.equal(rows[0].lon, -117.95);
      assert.equal(rows[0].address, 'New Place, 456 Oak Ave');
      assert.ok(rows[0].cached_at);
    });

    it('does not write to cache on Nominatim failure', async () => {
      global.fetch = async () => ({ ok: false, status: 500 });
      await reverseGeocode(34.0500, -117.9500, { db, cacheRadiusM: 100 });
      const count = db.prepare('SELECT COUNT(*) as c FROM geocode_cache').get().c;
      assert.equal(count, 0);
    });

    it('returns nearest cached entry when multiple are within radius', async () => {
      global.fetch = async () => { throw new Error('should not call'); };
      db.prepare('INSERT INTO geocode_cache (lat, lon, address, cached_at) VALUES (?, ?, ?, ?)').run(34.0290, -117.9190, 'Farther Place', '2026-04-01T00:00:00Z');
      db.prepare('INSERT INTO geocode_cache (lat, lon, address, cached_at) VALUES (?, ?, ?, ?)').run(34.0297, -117.9190, 'Nearest Place', '2026-04-01T00:00:00Z');
      const result = await reverseGeocode(34.0297, -117.9190, { db, cacheRadiusM: 100 });
      assert.equal(result, 'Nearest Place');
    });

    it('handles missing cache file gracefully', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'Fresh Lookup' }),
      });
      const result = await reverseGeocode(34.0500, -117.9500, { db, cacheRadiusM: 100 });
      assert.equal(result, 'Fresh Lookup');
    });

    it('handles empty cache file gracefully', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ display_name: 'Fresh Lookup' }),
      });
      // Empty database table is the equivalent of empty cache file
      const result = await reverseGeocode(34.0500, -117.9500, { db, cacheRadiusM: 100 });
      assert.equal(result, 'Fresh Lookup');
    });
  });
});

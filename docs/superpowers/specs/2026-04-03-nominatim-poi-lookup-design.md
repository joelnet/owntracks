# Nominatim POI Lookup Design

**Date:** 2026-04-03
**Status:** Approved

## Purpose

Replace the placeholder "POI Lookup at (lat, lon)" Discord message with an actual reverse geocode using OpenStreetMap Nominatim. Results are cached locally so repeated visits to the same area don't hit the API again.

## Requirements

- Reverse geocode the centroid coordinate when a `visit_started` event fires
- Use Nominatim's free, API-key-less reverse geocoding endpoint
- Display the full `display_name` address in the Discord notification
- On failure, send a "POI Lookup failed" message with raw coordinates
- Cache successful lookups to `data/geocode-cache.jsonl`
- Check cache (radius-based) before calling Nominatim
- Cache radius configurable in `config.yml`
- `visit_ended` messages remain unchanged (raw coordinates)
- No new npm dependencies (use Node built-in `fetch`)

## New Module: `src/lib/geocode.js`

### Exported Function

```
export async function reverseGeocode(lat, lon, { cacheFile, cacheRadiusM })
```

- `lat`, `lon` — coordinates to look up
- `cacheFile` — path to `data/geocode-cache.jsonl`
- `cacheRadiusM` — match radius for cache lookup (from config)

### Lookup Flow

1. Read `data/geocode-cache.jsonl` (one JSON object per line)
2. For each cached entry, compute Haversine distance to `(lat, lon)`
3. If any entry is within `cacheRadiusM`: return its `address` string (nearest match wins if multiple)
4. If no cache hit: call Nominatim reverse geocode API
5. On success: append new entry to JSONL, return `display_name`
6. On failure (network error, non-200, missing `display_name`): return `null`, do not cache

### Nominatim API Call

```
GET https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json
User-Agent: owntracks-journal/1.0
```

Returns JSON with `display_name` field containing the full address string, e.g.:
`"Target, 1234 E Foothill Blvd, Azusa, Los Angeles County, California, 91702, United States"`

### Haversine Reuse

Import `haversineDistance` from `./poi.js` — already exported and tested.

## Cache Format: `data/geocode-cache.jsonl`

One JSON object per line:

```json
{"lat": 34.0297, "lon": -117.9190, "address": "Target, 1234 E Foothill Blvd, Azusa, CA 91702, United States", "cached_at": "2026-04-03T12:00:00Z"}
```

| Field | Purpose |
|-------|---------|
| `lat`, `lon` | Coordinates used for radius-based cache matching |
| `address` | Full `display_name` from Nominatim |
| `cached_at` | ISO timestamp of when the entry was cached |

## Configuration

New section in `config.yml`:

```yaml
geocode:
  cache_radius_m: 100
```

### Parameter Rationale

- **`cache_radius_m: 100`** — Matches the default POI radius. If you're within 100m of a previously geocoded location, the same address applies. Large enough to cover GPS drift, small enough to distinguish neighboring businesses.

### Config Validation

Added to `src/lib/config.js`:
- `geocode` section is optional (feature disabled if absent)
- `cache_radius_m` must be a positive number if present

## Changes to `server.js`

### Import

```js
import { reverseGeocode } from "./lib/geocode.js";
```

### visit_started Handler (line 145-147)

Before:
```js
if (visitResult.type === 'visit_started') {
  discord.notify(`POI Lookup at (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)})`);
}
```

After:
```js
if (visitResult.type === 'visit_started') {
  const geocodeConfig = config.geocode;
  const address = geocodeConfig
    ? await reverseGeocode(visitResult.centroid.lat, visitResult.centroid.lon, {
        cacheFile: path.join(dataDir, 'geocode-cache.jsonl'),
        cacheRadiusM: geocodeConfig.cache_radius_m,
      })
    : null;
  if (address) {
    discord.notify(`POI Lookup at ${address}`);
  } else {
    discord.notify(`POI Lookup failed for (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)})`);
  }
}
```

When `geocode` config is absent, behavior falls back to the failure message with raw coordinates (preserving functionality without the feature configured).

### Async Note

The request handler is already `async`. The Nominatim call adds ~0.5-1s latency to the response, but the OwnTracks app fires and forgets — it does not wait on the response body. No impact on user experience.

## Testing

### Unit Tests: `src/lib/__tests__/geocode.test.js`

**Nominatim calls (mock `global.fetch`):**
- Successful response returns `display_name`
- Non-200 status returns `null`
- Network error (fetch throws) returns `null`
- Missing `display_name` in response body returns `null`
- Verify correct URL construction (`lat`, `lon`, `format=json`)
- Verify `User-Agent` header is set

**Cache behavior (use temp files):**
- Cache hit within radius returns cached `address`, does not call `fetch`
- Cache miss calls Nominatim and appends new entry to JSONL
- Failed Nominatim does not write to cache file
- Multiple cached entries — nearest within radius wins
- Empty/missing cache file does not error

### Integration Tests: `src/__tests__/server.test.js`

- Update existing `visit_started` test: mock `reverseGeocode` to return a known address, verify Discord message contains it
- Add failure case: mock `reverseGeocode` to return `null`, verify "POI Lookup failed" message

### Config Tests: `src/lib/__tests__/config.test.js`

- Valid `geocode` section accepted
- Config without `geocode` section accepted (feature disabled)
- Invalid `cache_radius_m` (non-number, negative, zero) throws

## Edge Cases

### Empty Cache File

First lookup always hits Nominatim. Cache file is created on first successful write (append mode).

### Cache File Missing

Treated as empty cache — no error, proceeds to Nominatim call. File created on first successful geocode.

### Nominatim Rate Limiting

Nominatim allows 1 request/second. With visit detection's dwell threshold (5 min minimum), concurrent lookups are effectively impossible. No rate limiter needed.

### Concurrent Requests

Multiple OwnTracks devices could theoretically trigger simultaneous visits. JSONL append is atomic at the OS level for small writes (<4KB), so concurrent appends are safe.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/geocode.js` | **New** — `reverseGeocode()` with cache logic |
| `src/lib/__tests__/geocode.test.js` | **New** — unit tests |
| `src/server.js` | Import geocode, update `visit_started` handler |
| `src/__tests__/server.test.js` | Update visit notification tests |
| `src/lib/config.js` | Add `geocode` section validation |
| `src/lib/__tests__/config.test.js` | Add geocode config tests |
| `config.yml` | Add `geocode` section |

# POI Detection Design

## Overview

Add Point of Interest (POI) geofencing to the OwnTracks location journal. The server detects when the user arrives at or departs from named locations and logs state transitions. POI configuration lives in a new `config.yml` file, separate from `.env` (which remains for secrets only).

## Config File

**File:** `config.yml` (project root)

```yaml
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0170901
      lon: -117.9025897
      # radius_m: 150  # optional per-POI override
```

- `default_radius_m` — global radius in meters applied to all POIs unless overridden
- `locations[]` — array of POIs, each with `name`, `lat`, `lon`, and optional `radius_m`
- Per-POI `radius_m` takes precedence over `default_radius_m`

**Loaded once at startup.** Server exits with an error if the file is missing or malformed.

## New Module: `lib/config.js`

Loads and parses `config.yml` using the `yaml` npm package (standard YAML parser for Node.js). Exports a function that reads the file synchronously at startup and returns the parsed config object. Validates that required fields are present.

## New Module: `lib/poi.js`

### Haversine Distance

Implements the Haversine formula to compute great-circle distance in meters between two lat/lon points. Uses Earth's mean radius of 6,371,008 meters. ~10 lines of code, zero dependencies.

### POI Detector

- **`createPOIDetector(config)`** — factory function that takes the parsed config object and returns a detector instance. Internal state tracks the last known location name (initialized to `null`).

- **`detector.detect(lat, lon)`** — checks the incoming coordinates against all configured POIs using Haversine distance. Returns `{ changed: boolean, location: string }`:
  - `location` is the matching POI `name`, or `"Roaming"` if no POI matches
  - `changed` is `true` when location differs from the previous detection
  - First detection always counts as a change (from `null` to a value)

If a point falls within the radius of multiple POIs, the first match in config order wins.

## Integration: `server.js`

### Startup

1. Import and call `lib/config.js` to load `config.yml`
2. Create a POI detector instance via `createPOIDetector(config)`

### Request Handling (`POST /pub`)

After authentication, before storage:

1. If the entry has `lat` and `lon` fields, call `detector.detect(lat, lon)`
2. If `changed` is `true`, log the transition: `Location: Home` or `Location: Roaming`
3. Proceed to storage as normal — **no changes to stored data format**

Entries without `lat`/`lon` (e.g., `_type: "transition"`) skip POI detection entirely.

The detector is a single per-process instance. This is a single-user system (one OwnTracks device), so no per-user state management is needed.

## Log Output

Location changes appear as standard INFO log entries:

```
2026-03-22T01:00:35.103Z [INFO] Location: Home
2026-03-22T01:15:22.456Z [INFO] Location: Roaming
2026-03-22T02:30:11.789Z [INFO] Location: Home
```

Location is only logged on state transitions. Repeated detections at the same location produce no log output.

## Dependencies

- **New:** `yaml` npm package (YAML parser)
- No other new dependencies

## Testing

### `lib/__tests__/poi.test.js`

- Point inside radius returns correct POI name
- Point outside all POIs returns `"Roaming"`
- `changed` is `true` only on state transitions (Home → Roaming, Roaming → Home)
- `changed` is `false` for repeated same-location detections
- Per-POI `radius_m` override takes precedence over `default_radius_m`
- Haversine accuracy: verify known distance between two real-world coordinates

### `lib/__tests__/config.test.js`

- Parses valid YAML with POI section
- Throws/exits on missing file
- Throws/exits on malformed YAML

### Existing Tests

Server integration tests continue to pass. Config loading is handled gracefully in test context (tests import the Express app directly and don't rely on `config.yml`).

## Files Changed

| File | Change |
|------|--------|
| `config.yml` | **New** — POI configuration |
| `lib/config.js` | **New** — YAML config loader |
| `lib/poi.js` | **New** — Haversine + POI detector |
| `lib/__tests__/poi.test.js` | **New** — POI detector tests |
| `lib/__tests__/config.test.js` | **New** — Config loader tests |
| `server.js` | **Modified** — import config + POI detector, add detection in handler |
| `package.json` | **Modified** — add `yaml` dependency |

## Out of Scope

- Storing POI name in JSONL entries
- Hot-reloading config changes
- Multiple user/device state tracking
- Reverse geocoding for unknown locations

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

Loads and parses `config.yml` using the `yaml` npm package (standard YAML parser for Node.js). Exports a function that reads the file synchronously at startup and returns the parsed config object.

Validation rules:
- `poi` key must exist and be an object
- `poi.default_radius_m` must be a positive number
- `poi.locations` must be a non-empty array
- Each location must have `name` (string), `lat` (number, -90 to 90), `lon` (number, -180 to 180)
- Optional `radius_m` must be a positive number if present

## New Module: `lib/poi.js`

### Haversine Distance

Implements the Haversine formula to compute great-circle distance in meters between two lat/lon points. Uses Earth's mean radius of 6,371,008 meters. ~10 lines of code, zero dependencies.

### POI Detector

- **`createPOIDetector(config)`** — factory function that takes the parsed config object and returns a detector instance. Internal state tracks the last known location name (initialized to `"Roaming"`).

- **`detector.detect(lat, lon)`** — checks the incoming coordinates against all configured POIs using Haversine distance. Returns `{ changed: boolean, location: string }`:
  - `location` is the matching POI `name`, or `"Roaming"` if no POI matches
  - `changed` is `true` when location differs from the previous detection
  - Since state starts as `"Roaming"`, the first detection only triggers a change if the user is at a POI

- **`detector.setLocation(name)`** — seeds the detector's last known location state. Used at startup to restore state from logs.

If a point falls within the radius of multiple POIs, the first match in config order wins.

### Startup State Recovery

At startup, the server reads `logs/location.log` and finds the last line matching `Location: <name>`. If found, calls `detector.setLocation(name)` and logs `Last known location: <name>`. Since location transitions are in a single file (no daily rotation), this is a simple scan — no new dependencies needed.

## Integration: `server.js`

### Dependency Injection

The POI detector is passed into `createApp` as an optional parameter: `createApp({ username, password, dataDir, detector })`. When `detector` is `null` or `undefined`, POI detection is skipped. This preserves testability — existing server tests call `createApp` without a detector and continue to pass unchanged. POI-specific integration tests can inject a test detector.

### Startup

1. Import and call `lib/config.js` to load `config.yml`
2. Create a POI detector instance via `createPOIDetector(config)`
3. Read `logs/location.log` to find the last `Location: <name>` entry and seed the detector's state. If found, log: `Last known location: Home`. If no prior location log exists, state remains `"Roaming"` (the default).
4. Pass the detector into `createApp`

### Request Handling (`POST /pub`)

After authentication, before storage:

1. If a detector is present and the entry has `lat` and `lon` fields, call `detector.detect(lat, lon)`
2. If `changed` is `true`, log the transition: `Location: Home` or `Location: Roaming`
3. Proceed to storage as normal — **no changes to stored data format**

Entries without `lat`/`lon` (e.g., `_type: "transition"`) skip POI detection entirely — no error, no state change.

The detector is a single per-process instance. This is a single-user system (one OwnTracks device), so no per-user state management is needed.

**On restarts:** Detector state is seeded from the last `Location:` entry in `logs/location.log`. This prevents a false transition log on restart when the user hasn't moved. If no log history exists, defaults to `"Roaming"`.

## Log Output

Two separate log files:

- **`logs/YYYY-MM-DD.log`** — application log (server events, errors, "Entry saved" messages). Existing behavior, unchanged.
- **`logs/location.log`** — location transitions only. Single file, no daily rotation. Lightweight and easy to scan for startup recovery.

Location log entries:

```
2026-03-22T01:00:00.000Z [INFO] Last known location: Home
2026-03-22T01:15:22.456Z [INFO] Location: Roaming
2026-03-22T02:30:11.789Z [INFO] Location: Home
```

Location transitions are written to `location.log` (and echoed to console). They are **not** written to the daily app log. Location is only logged on state transitions — repeated detections at the same location produce no log output.

## Dependencies

- **New:** `yaml` npm package (YAML parser)
- No other new dependencies

## Testing

### `lib/__tests__/poi.test.js`

- Point inside radius returns correct POI name
- Point outside all POIs returns `"Roaming"`
- Default state is `"Roaming"` — first detection while roaming returns `changed: false`
- First detection at a POI returns `changed: true` (Roaming → Home)
- `setLocation` seeds state — subsequent matching detection returns `changed: false`
- `changed` is `true` on state transitions (Home → Roaming, Roaming → Home)
- `changed` is `false` for repeated same-location detections
- Per-POI `radius_m` override takes precedence over `default_radius_m`
- When a point falls within multiple POI radii, the first POI in config order is returned
- Entries without lat/lon skip detection (no error, no state change)
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
| `lib/logger.js` | **Modified** — add location log writer (`logs/location.log`, single file) |
| `server.js` | **Modified** — import config + POI detector, add detection in handler |
| `package.json` | **Modified** — add `yaml` dependency |

## Out of Scope

- Storing POI name in JSONL entries
- Hot-reloading config changes
- Multiple user/device state tracking
- Reverse geocoding for unknown locations

# Activity Detection Design

## Overview

Add activity state detection to the OwnTracks server, inspired by GeoPulse's stay/trip detection algorithm. Classifies incoming GPS points into four states: `UNKNOWN`, `STATIONARY`, `WALKING`, `DRIVING`. Sends Discord notifications on state transitions. All thresholds are configurable in `config.yml`.

## Inspiration

GeoPulse (https://github.com/tess1o/geopulse) uses a 4-state FSM (UNKNOWN → POTENTIAL_STAY → CONFIRMED_STAY → IN_TRIP) with a sliding window of GPS points, speed-based classification, and dwell timers. This design takes the core concepts — windowed speed analysis, dwell timers, debouncing — and simplifies them for real-time Discord notifications rather than timeline reconstruction.

## Architecture

```
OwnTracks App → POST /pub → server.js → detector.detect() (POI, existing)
                                       → activity.update(lat, lon, tst, vel)
                                           ↓ (if changed)
                                         discord.notify("Now Driving")
```

Activity detection runs after POI detection on every location update. Both systems fire notifications independently — a single point can trigger both "Left Home" and "Now Driving".

## Configuration

New `activity` section in `config.yml`:

```yaml
activity:
  enabled: true
  discord_notifications: true
  dwell_threshold_minutes: 5
  walking_max_kmh: 7
  driving_min_kmh: 25
  window_size: 5
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | — | Master toggle for activity detection |
| `discord_notifications` | boolean | — | Whether state transitions send Discord messages |
| `dwell_threshold_minutes` | number | — | Minutes below walking speed before classifying as stationary |
| `walking_max_kmh` | number | — | Speed ceiling for walking; speeds between this and `driving_min_kmh` classify as walking |
| `driving_min_kmh` | number | — | Speed floor for driving |
| `window_size` | integer >= 2 | — | Number of recent points in the sliding window |

### Validation Rules

- `activity` section is optional. If missing, activity detection is off.
- `enabled` and `discord_notifications` must be booleans.
- `dwell_threshold_minutes` must be a positive number.
- `walking_max_kmh` must be a positive number.
- `driving_min_kmh` must be a positive number.
- `walking_max_kmh` must be less than `driving_min_kmh`.
- `window_size` must be an integer >= 2.

## Module: `lib/activity.js`

### Exports

`createActivityDetector(config)` — factory that returns a detector instance.

### Detector Methods

- `update(lat, lon, timestamp, vel)` — process a new point. Returns `{ changed, state, previousState }`.
- `getState()` — returns current state string.
- `setState(savedState)` — restore full state from persisted JSON (startup recovery).
- `getFullState()` — returns the complete internal state for persistence.

### Internal State

- `window` — array of recent points `{ lat, lon, timestamp, vel }`, capped at `window_size`
- `currentState` — one of `UNKNOWN`, `STATIONARY`, `WALKING`, `DRIVING`
- `dwellStart` — timestamp when speed first dropped below walking threshold, null if moving
- `pendingState` — candidate state for debounce
- `pendingCount` — consecutive points agreeing on the pending state

## State Machine

Four states: `UNKNOWN`, `STATIONARY`, `WALKING`, `DRIVING`.

### Per-Update Flow

1. New point arrives with `lat`, `lon`, `timestamp`, `vel`.
2. Add to window. Drop oldest if at capacity.
3. If window is not full, remain in `UNKNOWN`. Return `{ changed: false }`.
4. Calculate **median speed** across the window:
   - For each consecutive pair of points, compute speed as `haversineDistance(p1, p2) / timeDelta` (m/s → km/h).
   - Also consider the OwnTracks `vel` field for each point.
   - For each point, take the **higher** of reported `vel` and calculated speed (cross-check against stale `vel` values).
   - Take the **median** of these values across the window.
5. Classify candidate state:
   - median >= `driving_min_kmh` → `DRIVING`
   - median < `driving_min_kmh` → `WALKING` (the in-transit zone between walking_max and driving_min rounds down)
   - median < `walking_max_kmh` → check dwell timer
6. **Dwell timer:** When median speed drops below `walking_max_kmh`:
   - If `dwellStart` is null, set it to the current timestamp.
   - If `now - dwellStart >= dwell_threshold_minutes`, candidate is `STATIONARY`.
   - Otherwise, candidate remains `WALKING` (avoids false stationary at traffic lights).
   - When median speed rises above `walking_max_kmh`, reset `dwellStart` to null.
7. **Debounce:** Compare candidate with `pendingState`.
   - If same: increment `pendingCount`.
   - If different: reset `pendingState` to candidate, `pendingCount` = 1.
   - Transition fires only when `pendingCount >= 2` AND `pendingState !== currentState`.
8. On transition: set `previousState = currentState`, update `currentState`, persist state to disk. Return `{ changed: true, state: currentState, previousState }`.

### Initial Classification

The first classification after the window fills transitions from `UNKNOWN` to the detected state **silently** — `changed` returns `false` to suppress the notification. This avoids "Now Stationary" on every server restart.

## Discord Notifications

When `activity.discord_notifications` is `true` and a state transition occurs:

| Transition | Message |
|---|---|
| `STATIONARY → WALKING` | `Now Walking` |
| `STATIONARY → DRIVING` | `Now Driving` |
| `WALKING → DRIVING` | `Now Driving` |
| `WALKING → STATIONARY` | `Now Stationary` |
| `DRIVING → WALKING` | `Now Walking` |
| `DRIVING → STATIONARY` | `Now Stationary` |

Activity notifications fire regardless of POI status (at a POI or roaming). Activity and POI notifications are independent — both can fire on the same point.

## State Persistence

### File: `data/activity-state.json`

```json
{
  "currentState": "DRIVING",
  "window": [
    { "lat": 34.017, "lon": -117.902, "timestamp": 1711036800, "vel": 45 },
    { "lat": 34.018, "lon": -117.903, "timestamp": 1711036830, "vel": 42 }
  ],
  "dwellStart": null,
  "pendingState": "DRIVING",
  "pendingCount": 2
}
```

- Written on every state change (`changed: true`), not on every point.
- On startup: if file exists and is valid JSON, load and restore full state via `setState()`. Detector resumes exactly where it left off.
- If file is missing or corrupt: start fresh in `UNKNOWN`.

## Integration with `server.js`

### Startup

1. Load config (existing).
2. Create POI detector (existing).
3. If `config.activity?.enabled`, create activity detector via `createActivityDetector(config.activity)`.
4. Attempt to load `data/activity-state.json` and call `detector.setState(savedState)`.
5. Pass activity detector into `createApp()` via dependency injection (optional, like discord).

### POST Handler

After POI detection:

```
1. POI detect (existing)
2. If activity detector exists and entry has lat/lon:
     result = activity.update(lat, lon, tst, vel)
3. If result.changed && config.activity.discord_notifications:
     discord.notify(`Now ${result.state}`)
4. POI notification (existing, unchanged)
5. Store entry (existing)
```

### Dependency

Uses `haversineDistance` from `lib/poi.js` for calculated speed between consecutive points. No new npm dependencies.

## Testing

### `lib/__tests__/activity.test.js`

- **Window filling:** Stays `UNKNOWN` until window reaches `window_size`.
- **Initial classification is silent:** First classification after window fills returns `changed: false`.
- **Speed classification:** Correct state for speeds in each range (stationary, walking, driving).
- **Dwell timer:** Does not go stationary until `dwell_threshold_minutes` elapsed.
- **Dwell timer reset:** Moving above walking speed resets the dwell timer.
- **Debounce:** Single-point speed spikes do not trigger transitions.
- **State persistence round-trip:** `getFullState()` → `setState()` restores identical behavior.
- **Cross-check:** Calculated speed used when `vel` is stale/zero.

### `lib/__tests__/config.test.js` (additions)

- Valid activity config passes validation.
- Missing activity section is allowed (feature off).
- Invalid types rejected (non-boolean enabled, non-number thresholds).
- `walking_max_kmh >= driving_min_kmh` rejected.
- `window_size < 2` rejected.

### `__tests__/server.test.js` (additions)

- Activity detection fires on location updates when enabled.
- Discord notification sent on activity state change.
- Activity detection skipped when not configured.
- Activity and POI notifications both fire on same point when both change.

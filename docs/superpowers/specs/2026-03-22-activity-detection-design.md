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
- When the `activity` section is present, **all fields are required**.
- `enabled` and `discord_notifications` must be booleans.
- `dwell_threshold_minutes` must be a positive number.
- `walking_max_kmh` must be a positive number.
- `driving_min_kmh` must be a positive number.
- `walking_max_kmh` must be less than `driving_min_kmh`.
- `window_size` must be an integer >= 3 (minimum for meaningful median calculation).

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

1. New point arrives with `lat`, `lon`, `timestamp`, `vel`. Treat `vel` as 0 when missing, null, negative, or non-numeric.
2. Add to window. Drop oldest if at capacity. The window is sorted by timestamp after insertion to handle out-of-order points (OwnTracks can batch/queue points during connectivity loss).
3. If window is not full, remain in `UNKNOWN`. Return `{ changed: false }`.
4. Calculate **median speed** across the window:
   - For each consecutive pair `(p[i], p[i+1])`, compute `calculated_speed = haversineDistance(p[i], p[i+1]) / timeDelta` converted to km/h.
   - If `timeDelta` between a pair is 0, skip that pair (avoid division by zero).
   - Treat `vel` as 0 when it is missing, null, negative, or non-numeric.
   - For each pair, take `max(calculated_speed, p[i+1].vel)` as that segment's speed. This yields N-1 speed values for a window of N points.
   - If no valid pairs exist (all skipped), do not classify — remain in current state and return `{ changed: false }`.
   - Take the **median** of the valid speed values.
5. Classify candidate state (evaluated top-to-bottom, first match wins):
   - median >= `driving_min_kmh` → candidate = `DRIVING`
   - median >= `walking_max_kmh` → candidate = `WALKING` (the zone between `walking_max_kmh` and `driving_min_kmh` covers cycling, running, slow traffic — classified as walking)
   - median < `walking_max_kmh` → check dwell timer (step 6)
6. **Dwell timer:** When median speed is below `walking_max_kmh`:
   - If `dwellStart` is null, set it to the current timestamp.
   - If `now - dwellStart >= dwell_threshold_minutes`, candidate = `STATIONARY`.
   - Otherwise, candidate = `WALKING` (avoids false stationary at traffic lights).
   - When median speed rises to or above `walking_max_kmh`, reset `dwellStart` to null.
   - Note: the effective time to reach `STATIONARY` is approximately `dwell_threshold_minutes` + 2 reporting intervals, because the debounce (step 7) requires 2 consecutive agreeing points after the dwell timer fires.
7. **Debounce:** Compare candidate with `pendingState`.
   - If same: increment `pendingCount`.
   - If different: reset `pendingState` to candidate, `pendingCount` = 1.
   - Transition fires only when `pendingCount >= 2` AND `pendingState !== currentState`.
8. On transition: set `previousState = currentState`, update `currentState`, persist state to disk. Return `{ changed: true, state: currentState, previousState }`.

### Initial Classification

The first classification after the window fills transitions from `UNKNOWN` to the detected state **silently** — `changed` returns `false` to suppress the notification. This avoids "Now Stationary" on every server restart. The state is still persisted to disk on this initial classification so it survives a subsequent restart.

Transitions from `UNKNOWN` never generate Discord notifications (whether from initial classification or state recovery edge cases).

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

Transitions from `UNKNOWN` do not generate notifications. Activity notifications fire regardless of POI status (at a POI or roaming). Activity and POI notifications are independent — both can fire on the same point.

State names are title-cased in notification messages (e.g. `DRIVING` → `"Driving"`).

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

- Written on every state change (`changed: true`) and on the silent initial classification (when transitioning out of `UNKNOWN`). Not written on every point.
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
2. If activity detector exists and entry.type === 'location' and entry has lat/lon:
     result = activity.update(lat, lon, tst, vel)
3. If result.changed or result.initialClassification:
     write activity.getFullState() to data/activity-state.json
4. If result.changed && config.activity.discord_notifications:
     discord.notify(`Now ${titleCase(result.state)}`)
5. POI notification (existing, unchanged)
6. Store entry (existing)
```

Only `_type: "location"` entries are fed to the activity detector. Transition events and other OwnTracks message types are skipped.

### Persistence Ownership

`server.js` is responsible for reading and writing the state file (consistent with how POI state recovery works). The activity detector itself has no knowledge of the file path — it exposes `getFullState()` and `setState()` for the server to use.

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
- **Missing/invalid vel:** Treats missing, null, negative vel as 0.
- **Zero time delta:** Skips pairs with identical timestamps.
- **Out-of-order points:** Window sorts by timestamp, produces correct speeds.
- **Initial classification persists:** State file written on first classification even though `changed` is false.
- **Only location type:** Non-location entries (transitions, waypoints) are not processed.

### `lib/__tests__/config.test.js` (additions)

- Valid activity config passes validation.
- Missing activity section is allowed (feature off).
- Invalid types rejected (non-boolean enabled, non-number thresholds).
- `walking_max_kmh >= driving_min_kmh` rejected.
- `window_size < 3` rejected.

### `__tests__/server.test.js` (additions)

- Activity detection fires on location updates when enabled.
- Discord notification sent on activity state change.
- Activity detection skipped when not configured.
- Activity and POI notifications both fire on same point when both change.

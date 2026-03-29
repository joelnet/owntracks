# Visit Detection & POI Discovery Design

**Date:** 2026-03-29
**Status:** Approved

## Purpose

Detect when the user is visiting an unknown location (not a configured POI) and trigger a POI lookup. The actual reverse geocode/place API call is a placeholder for now — the system sends a "POI Lookup" Discord message. Discovered locations are saved as learned POIs so they are automatically recognized on future visits without another lookup.

## Requirements

- Detect meaningful stops at unknown locations (conservative — avoid false positives)
- Capture the actual destination coordinate, not the parking spot (handle park-and-walk)
- Skip locations already covered by known POIs (configured or learned)
- Send a Discord notification as a placeholder for the future reverse geocode
- Save discovered locations as learned POIs for automatic future recognition
- Persist state across server restarts

## Approach: Visit Session with Walk Radius

Based on the Ye et al. (2009) "stay point" research: a visit is declared when GPS points remain within a containment radius for a minimum dwell time. This is implemented as a "visit session" that integrates with the existing activity and POI detectors.

### Research Background

| Source | Key Insight |
|--------|-------------|
| Ye et al. (2009) | Stay point = all points within radius R for duration T |
| SafeGraph | DBSCAN clustering (80m threshold) + driving filter + ML ranking |
| Apple iOS Visits | Dwell-based arrival/departure detection at significant locations |
| Radar.io | Multi-signal: footprint, popularity, time of day |

Common pattern: **dwell time + spatial containment = a visit**.

## Visit Session Lifecycle

### Open Conditions (all must be true)

- POI detector reports `"Roaming"` (not at any known POI)
- Activity state is **not** `DRIVING` (i.e., is `WALKING`, `STATIONARY`, or `UNKNOWN`)
- No visit session is already active

This is evaluated per-point, not as a transition event. If the server starts up and the user is already at a store (activity = `STATIONARY`, POI = `"Roaming"`), a session opens on the first qualifying point.

### During Session

- Accumulate GPS points into the session
- Track an **anchor point** (first point) and a **running centroid** (mean lat/lon of all accumulated points)
- Monitor containment: are all points within the containment radius of the anchor?

### Trigger Conditions (fire the POI lookup)

- Points have remained within the containment radius for at least the minimum dwell time
- Lookup fires **once per session**, at the centroid coordinate

### Close Conditions (any one)

- Activity transitions to `DRIVING`
- POI detector transitions to a known POI
- A point arrives outside the containment radius and stays outside for the exit timeout duration (transit walking, not browsing)

### On Close

- If a lookup was triggered: the visit is complete — log it with arrival/departure times and centroid
- If no lookup was triggered (too brief, passed through): discard silently

## Configuration

New section in `config.yml`:

```yaml
visit_detection:
  enabled: true
  containment_radius_m: 200      # all points must stay within this radius
  min_dwell_minutes: 5            # time within radius before triggering lookup
  exit_timeout_minutes: 3         # time outside radius before closing session
  discord_notifications: true     # send "POI Lookup" placeholder to Discord
  learn_pois: true                # save discovered locations as learned POIs
  learned_poi_radius_m: 100       # default radius for auto-learned POIs
```

### Parameter Rationale

- **`containment_radius_m: 200`** — Large enough to cover a store + parking lot. Small enough to avoid triggering while driving slowly through a neighborhood.
- **`min_dwell_minutes: 5`** — Matches the existing activity dwell threshold. Filters out red lights and brief stops.
- **`exit_timeout_minutes: 3`** — If you walk beyond the radius briefly (cross a street, walk to your car), the session isn't immediately killed. Sustained movement away closes it.
- **`learned_poi_radius_m: 100`** — Matches the existing `default_radius_m` for consistency when saving discovered POIs.

## State Management & Persistence

### Visit Session State

Persisted to `data/visit-session.json` after every point:

```json
{
  "active": true,
  "anchor": { "lat": 34.0297, "lon": -117.9190 },
  "centroid": { "lat": 34.0298, "lon": -117.9188 },
  "point_count": 12,
  "started_at": "2026-03-29T14:30:00Z",
  "triggered": false,
  "last_outside_at": null
}
```

| Field | Purpose |
|-------|---------|
| `anchor` | First point in the session; used to measure containment |
| `centroid` | Running mean of all accumulated points; the lookup coordinate |
| `point_count` | Needed to incrementally update centroid without storing all points |
| `triggered` | Whether the lookup has already fired (prevents duplicates) |
| `last_outside_at` | Timestamp of first point outside containment radius; used by exit timeout. Reset to `null` when a point comes back inside. |

### Incremental Centroid Update

No need to store all points:

```
new_lat = old_lat + (point.lat - old_lat) / new_count
new_lon = old_lon + (point.lon - old_lon) / new_count
```

### Learned POIs

Persisted to `data/learned-pois.json`:

```json
[
  {
    "name": "Unknown (34.0298, -117.9188)",
    "lat": 34.0298,
    "lon": -117.9188,
    "radius_m": 100,
    "discovered_at": "2026-03-29T14:35:00Z",
    "visit_count": 1,
    "last_visited_at": "2026-03-29T14:35:00Z"
  }
]

```

- `name` is a coordinate placeholder until the real reverse geocode is implemented
- On startup, learned POIs are loaded and merged into the POI detector's location list alongside hand-configured ones from `config.yml`
- On revisit, the POI detector recognizes the learned location and no visit session opens

## Integration & Data Flow

### Pipeline Position

```
GPS point → accuracy filter → POI detect → activity detect → visit detect → store → respond
```

The visit detector sits **after** both POI and activity detectors because it consumes their outputs as inputs.

### Module Interface

**`src/lib/visit.js`**

```
createVisitDetector(config, savedState?)
  → returns {
      processPoint(point, poiResult, activityState) → visitEvent | null,
      getState() → sessionState,
      getLearnedPois() → learnedPoi[],
      loadLearnedPois(pois) → void
    }
```

- `config` — the `visit_detection` config section
- `savedState` — optional previously persisted session state (from `visit-session.json`)
- `poiResult` — current POI name or `"Roaming"` (from `poi.js`)
- `activityState` — current activity state: `DRIVING`, `WALKING`, `STATIONARY`, `UNKNOWN` (from `activity.js`)
- Returns a visit event when something notable happens, or `null` for most points
- `getState()` — returns current session state for persistence
- `getLearnedPois()` / `loadLearnedPois()` — manage the learned POI list (loaded from `data/learned-pois.json` at startup)

### Visit Events

| Event | When | Discord Message |
|-------|------|-----------------|
| `visit_started` | Dwell threshold met, lookup fires | `"POI Lookup at (34.0298, -117.9188)"` |
| `visit_ended` | Session closes after a triggered visit | `"Left unknown location (34.0298, -117.9188) — 45 min visit"` |

### Boundaries

- Does **not** modify POI detector or activity detector internals
- Does **not** re-filter accuracy (already done upstream)
- Does **not** store points itself (main pipeline writes to JSONL)

### Startup Restoration

1. Load `data/visit-session.json` — restore active session if any
2. Load `data/learned-pois.json` — inject into POI detector's location list

## Edge Cases

### GPS Gaps (phone sleeps, tunnel, signal loss)

Session stays in its last state until the next point arrives:
- Within containment radius → session continues as if uninterrupted
- Outside containment radius → close session (gap counts toward exit timeout)
- At a known POI → close session

### Server Restart Mid-Session

Session state is persisted after every point. On restart, load `visit-session.json` and resume. The next incoming point picks up where it left off.

### Rapid POI Transitions

Driving past a known POI briefly (POI detector flickers) does not open a visit session because the activity state is still `DRIVING`.

### Walking Transit (not a visit)

Walking from a car across a large parking lot to another block — points eventually leave the containment radius. After `exit_timeout_minutes` outside, the session closes without triggering and is discarded.

### Overlapping with Learned POIs

If a learned POI already covers this location, the POI detector reports its name instead of `"Roaming"`, so no visit session opens.

### Duplicate Learned POIs

Before saving a new learned POI, check if any existing learned POI's centroid is within `learned_poi_radius_m` of the new one. If so, update the existing entry (bump `visit_count`, update `last_visited_at`, refine centroid) instead of creating a duplicate.

### Centroid Accuracy

Points that pass the existing `max_accuracy_m` filter are already reasonably clean. The incremental centroid naturally smooths out remaining noise as more points accumulate.

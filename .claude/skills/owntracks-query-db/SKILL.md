---
name: owntracks-query-db
description: Query the OwnTracks SQLite database (data/owntracks.db) to diagnose why a visit, POI lookup, geocode, or activity transition did or didn't happen at a specific moment. Use whenever the user asks "why didn't I get a POI lookup at X o'clock", "why didn't a visit trigger", "what does the DB show around time T", "show me my GPS points between A and B", "did the geocoder run", or any forensic question about a past moment that needs reconstruction from stored points, app_state, geocode_cache, or learned_pois. Also use when troubleshooting suppression, dwell timing, or accuracy filtering.
---

# OwnTracks Query DB

The authoritative store for everything OwnTracks records is `data/owntracks.db` (SQLite). When the user asks why something did or didn't happen at a particular time, run the bundled `scripts/diagnose.js` against that moment and reason from the output. Do not read the old JSON files (`visit-session.json`, `activity-state.json`, `learned-pois.json`, `geocode-cache.jsonl`) — those were superseded by the database around 2026-04-04 and now contain stale snapshots.

## First move

Run the diagnostic script for the window the user named. It dumps location points, app_state, geocode hits, and the nearest configured POIs in one pass — enough to answer most questions without ad-hoc SQL.

```bash
# Window of ±30 min (default) around 3:04pm yesterday
node .claude/skills/owntracks-query-db/scripts/diagnose.js "2026-06-04 15:04 PDT"

# Custom window, in minutes
node .claude/skills/owntracks-query-db/scripts/diagnose.js "2026-06-04T22:04:00Z" 60

# Epoch seconds also accepted
node .claude/skills/owntracks-query-db/scripts/diagnose.js 1780610640
```

Output includes `[SKIP]` for points the server filtered out (acc > `max_accuracy_m`), `[POI:Name]` for points inside a configured POI radius, `Δ<seconds>` between adjacent points so data gaps stand out, and times in both UTC and the user's local zone (America/Los_Angeles).

## Schema cheat sheet

```
location_entries(id, username, device, lat, lon, tst, acc, vel, type, received_at, data)
  tst         epoch SECONDS (UTC)
  received_at epoch MILLISECONDS

app_state(key, value, updated_at)
  keys: 'activity_state', 'visit_session'
  updated_at is epoch MILLISECONDS — only updated when state changes,
  so a stale row is the norm. Treat it as a snapshot, not a time series.

geocode_cache(id, lat, lon, address, cached_at)
  cached_at epoch MILLISECONDS

learned_pois(...) — auto-discovered POIs from prior visits
```

No `sqlite3` CLI is installed on this host. Query through node with `better-sqlite3` (already in `package.json`):

```js
import Database from 'better-sqlite3';
const db = new Database('data/owntracks.db', { readonly: true });
const rows = db.prepare('SELECT … WHERE tst BETWEEN ? AND ?').all(start, end);
```

## Reasoning checklist for "why didn't X happen?"

Whatever the diagnostic dump shows, walk these in order — most "missing event" reports trace to one of them:

1. **Accuracy filter ate the points.** Any `[SKIP]` row was filtered at `src/server.js:71-78` and never reached the visit/activity detectors. Two or three `[SKIP]`s at the start of a real stop can erase the dwell window. Threshold is `max_accuracy_m` in `config.yml`.

2. **Data gap shifted the perceived stop.** A `Δ` larger than `activity.dwell_threshold_minutes` (5 min default) forces activity state to `STATIONARY` and resets the window (`src/lib/activity.js:57-71`). The visit session anchors at the *next* point, not at the real stop start, so dwell starts late.

3. **Containment radius violated before dwell.** Visit sessions require the user stays within `visit_detection.containment_radius_m` (200m) of the anchor for `min_dwell_minutes` (5 min). If the anchor was the first clean post-gap point but the user pulled away within ~3 min, dwell never reached the threshold (`src/lib/visit.js:117-154`).

4. **Suppression because centroid is near a known POI.** When `min_distance_from_known_poi_m` is set, a triggered visit whose centroid falls inside `(poi.radius + guard)` is suppressed and emits no event (`src/lib/visit.js:131-133`). `app_state.visit_session.suppressed=true` is the smoking gun.

5. **Activity was DRIVING.** No visit session opens or stays open while activity is `DRIVING` (`src/lib/visit.js:103, 107`).

6. **Already at a configured POI.** Visit sessions only open when `poiResult === 'Roaming'`. If the diagnostic flags `[POI:Home]` etc., a visit can't open — that's by design.

7. **Geocode cache absorbed it.** A `visit_started` event still might not produce a *new* Discord message if the centroid hit a cached geocode within `geocode.cache_radius_m` (100m). Check the geocode_cache hits section of the dump.

## Cross-referencing logs

The DB tells you what was *stored*. The logs tell you what was *processed*.

- `logs/<YYYY-MM-DD>.log` has per-request lines like `Entry saved (skipped detection, acc=36)` — direct confirmation that `[SKIP]` happened.
- `logs/location.log` only records POI named-transitions (Home, Work, Roaming, etc.). Absence of a line during a window confirms no POI transition fired.
- For systemd-level issues, hand off to the `owntracks-read-logs` skill.

## Time zone discipline

The user lives in `America/Los_Angeles`. Casual times ("3:04pm yesterday") are local. `tst` and `received_at` in the DB are UTC. The diagnostic script handles the conversion; if you're writing ad-hoc queries, convert explicitly and show both UTC and local in your output so the user can verify the moment is right.

## Reporting back

Lead with a short answer ("Visit session opened at 22:08:54 UTC but you drove off 2 min later — never met the 5-min dwell"), then a compact timeline of the relevant rows (the script's table is usually fine to paste), then the specific config values and code locations (`file:line`) that explain it. Cite the rule that fired, not just the symptom.

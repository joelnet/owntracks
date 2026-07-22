import { createPOIDetector, haversineDistance, poiAnchors } from './poi.js';
import { createActivityDetector } from './activity.js';
import { createVisitDetector } from './visit.js';
import { reverseGeocode } from './geocode.js';

// --- Helpers ---

export function toLocalDate(tst, tz) {
  return new Date(tst * 1000).toLocaleDateString('en-CA', { timeZone: tz });
}

export function toLocalTime(tst, tz) {
  return new Date(tst * 1000).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtState(s) {
  if (!s || s === 'N/A') return s;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

export function adjacentDate(dateStr, offset) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function tzOffsetMs(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const localAsUtc = Date.UTC(
    parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
    parseInt(parts.hour), parseInt(parts.minute), parseInt(parts.second),
  );
  return localAsUtc - date.getTime();
}

// Returns the UTC unix timestamp (seconds) corresponding to 00:00:00 local time
// of `dateStr` in `tz`. Two-pass to handle DST: the offset at our first guess
// may differ from the offset at true local midnight (e.g. on fall-back days).
export function localMidnightTst(dateStr, tz) {
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const firstOffset = tzOffsetMs(new Date(utcMidnight), tz);
  let guess = utcMidnight - firstOffset;
  const refinedOffset = tzOffsetMs(new Date(guess), tz);
  if (refinedOffset !== firstOffset) {
    guess = utcMidnight - refinedOffset;
  }
  return Math.floor(guess / 1000);
}

function createStaleTstTracker() {
  let lastTst = null;
  return function effectiveTst(entry) {
    if (typeof entry.tst === 'number' && entry.tst === lastTst) {
      return Math.floor(new Date(entry.received_at).getTime() / 1000);
    }
    if (typeof entry.tst === 'number') lastTst = entry.tst;
    return entry.tst;
  };
}

/**
 * Replay a day's stored points through the detectors and return structured
 * day data (timeline events, per-place totals, activity totals, distances),
 * or null if no data found. Shared by the text report and the vault journal.
 */
export async function buildDayData(date, config, db, timezone) {
  const tz = timezone || process.env.TZ || 'America/Los_Angeles';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const maxAccuracy = config.max_accuracy_m;

  // Query entries spanning the local date (3-day UTC window to cover timezone offsets)
  const prevDate = adjacentDate(date, -1);
  const nextDate = adjacentDate(date, 1);
  const startTst = Math.floor(new Date(prevDate + 'T00:00:00Z').getTime() / 1000);
  const endTst = Math.floor(new Date(nextDate + 'T23:59:59Z').getTime() / 1000);

  const allEntries = db.prepare(
    'SELECT data FROM location_entries WHERE type = ? AND lat IS NOT NULL AND lon IS NOT NULL AND tst >= ? AND tst <= ? ORDER BY tst'
  ).all('location', startTst, endTst).map(row => JSON.parse(row.data));

  const locationEntries = allEntries
    .filter(e => typeof e.lat === 'number' && typeof e.lon === 'number')
    .filter(e => !maxAccuracy || typeof e.acc !== 'number' || e.acc <= maxAccuracy)
    .sort((a, b) => a.tst - b.tst);

  const dayEntries = locationEntries.filter(e => toLocalDate(e.tst, tz) === date);
  const seedEntries = locationEntries.filter(e => e.tst < (dayEntries[0]?.tst ?? Infinity));

  if (dayEntries.length === 0) {
    return null;
  }

  // Day boundaries anchor to local midnight, not the first/last GPS point. This
  // matters because OwnTracks throttles updates while stationary — a phone idle
  // at Home overnight may not send anything until morning, but the user was
  // still Home for those hours.
  const dayStartTst = localMidnightTst(date, tz);
  const nextMidnightTst = localMidnightTst(adjacentDate(date, 1), tz);
  const nowTst = Math.floor(Date.now() / 1000);
  const lastEntryTst = dayEntries[dayEntries.length - 1].tst;
  const dayEndTst = nowTst < nextMidnightTst
    ? Math.max(nowTst, lastEntryTst) // today: end at "now" (clamp up to last entry if clock skew)
    : nextMidnightTst - 1; // past day: 23:59:59 of the date

  // Process through detectors. Displacement-based stationary inference is
  // disabled here (as vel already is — the replay never passes it) so the
  // immediate-arrival and drift-suppression fast paths stay inert and tuning
  // baselines stay locked.
  const poi = createPOIDetector({ ...config, poi: { ...config.poi, stationary_displacement_m: 0 } });
  const activity = config.activity?.enabled
    ? createActivityDetector(config.activity)
    : null;
  const visitConfig = config.visit_detection;
  const visit = visitConfig?.enabled !== false
    ? createVisitDetector(visitConfig || {
        containment_radius_m: 200, min_dwell_minutes: 5,
        exit_timeout_minutes: 3, learn_pois: true, learned_poi_radius_m: 100,
      })
    : null;
  if (visit) {
    visit.setKnownPois(
      config.poi.locations.flatMap(p => poiAnchors(p, config.poi.default_radius_m))
    );
  }

  const effectiveTst = createStaleTstTracker();

  for (const e of seedEntries) {
    const tst = effectiveTst(e);
    poi.detect(e.lat, e.lon, tst);
    if (activity) activity.update(e.lat, e.lon, tst, e.vel);
    if (visit) {
      const poiLoc = poi.getLocation();
      const actState = activity?.getState() ?? 'UNKNOWN';
      visit.processPoint({ lat: e.lat, lon: e.lon, tst }, poiLoc, actState);
    }
  }

  const events = [];
  let prevPoint = null;
  let trackingState = activity?.getState() ?? null;
  const distanceByState = {};

  events.push({
    tst: dayStartTst,
    type: 'start',
    location: poi.getLocation(),
    activity: activity?.getState() ?? 'N/A',
  });

  for (const e of dayEntries) {
    const tst = effectiveTst(e);

    // Accumulate distance to current activity state before updating
    if (prevPoint && trackingState && trackingState !== 'UNKNOWN') {
      const d = haversineDistance(prevPoint.lat, prevPoint.lon, e.lat, e.lon);
      distanceByState[trackingState] = (distanceByState[trackingState] || 0) + d;
    }

    const poiResult = poi.detect(e.lat, e.lon, tst);
    const actResult = activity?.update(e.lat, e.lon, tst, e.vel);

    if (poiResult.changed) {
      // Direct POI→POI transitions (no Roaming gap) skip the "Left X" line
      // because only the new location is logged. Synthesize a Left event for
      // the previous POI so the user sees both halves of the transition.
      if (poiResult.previousLocation !== 'Roaming' && poiResult.location !== 'Roaming') {
        events.push({
          tst,
          type: 'poi',
          location: 'Roaming',
          previousLocation: poiResult.previousLocation,
        });
      }
      events.push({
        tst,
        type: 'poi',
        location: poiResult.location,
        previousLocation: poiResult.previousLocation,
      });
    }

    if (actResult?.gapTransition) {
      trackingState = actResult.gapTransition.state;
      events.push({
        tst: actResult.gapTransition.timestamp,
        type: 'activity',
        state: actResult.gapTransition.state,
        previousState: actResult.gapTransition.previousState,
      });
    }

    if (actResult && (actResult.changed || actResult.initialClassification)) {
      trackingState = actResult.state;
      events.push({
        tst,
        type: 'activity',
        state: actResult.state,
        previousState: actResult.previousState,
      });
    }

    // Visit detection
    if (visit) {
      const poiLoc = poi.getLocation();
      const actState = activity?.getState() ?? 'UNKNOWN';
      const visitResult = visit.processPoint({ lat: e.lat, lon: e.lon, tst }, poiLoc, actState);
      if (visitResult) {
        events.push({
          tst,
          type: 'visit',
          visitType: visitResult.type,
          centroid: visitResult.centroid,
          duration_minutes: visitResult.duration_minutes,
        });
      }
    }

    prevPoint = { lat: e.lat, lon: e.lon };
  }

  // For the day-end summary, prefer the geographic truth over the detector's
  // latched state. The POI detector may still say "Roaming" if a re-entry to
  // Home POI had only 2 valid points before SKIPs ate the rest; resolveLocation
  // against the last GPS point reflects where the user actually was. Likewise
  // project STATIONARY when no fresh point has arrived for longer than the
  // activity dwell threshold — a gap-reset would have fired had any point
  // come in to trigger the gap check.
  const lastDayEntry = dayEntries[dayEntries.length - 1];
  const endLocation = lastDayEntry
    ? poi.resolveLocation(lastDayEntry.lat, lastDayEntry.lon)
    : poi.getLocation();
  const dwellThresholdSec = (config.activity?.dwell_threshold_minutes ?? 5) * 60;
  const hasEndGap = lastDayEntry && (dayEndTst - lastDayEntry.tst) > dwellThresholdSec;
  const replayEndActivity = activity?.getState();
  if (activity && hasEndGap && replayEndActivity !== 'STATIONARY' && replayEndActivity !== 'UNKNOWN') {
    // No point arrived to trigger the detector's normal gap transition. Close
    // movement after the dwell threshold so a final daily summary does not
    // count Walking/Driving all the way to midnight.
    events.push({
      tst: lastDayEntry.tst + dwellThresholdSec,
      type: 'activity',
      state: 'STATIONARY',
      previousState: replayEndActivity,
    });
  }
  const endActivity = activity
    ? (hasEndGap ? 'STATIONARY' : replayEndActivity)
    : 'N/A';
  events.push({
    tst: dayEndTst,
    type: 'end',
    location: endLocation,
    activity: endActivity,
  });

  // Geocode visit events
  const geocodeConfig = config.geocode;
  for (const ev of events.filter(e => e.type === 'visit')) {
    if (geocodeConfig && db) {
      try {
        ev.address = await reverseGeocode(ev.centroid.lat, ev.centroid.lon, {
          db, cacheRadiusM: geocodeConfig.cache_radius_m || 100,
        });
      } catch { /* geocode failure is non-fatal */ }
    }
    if (!ev.address) {
      ev.address = `(${ev.centroid.lat.toFixed(4)}, ${ev.centroid.lon.toFixed(4)})`;
    }
  }

  events.sort((a, b) => a.tst - b.tst || (a.type === 'start' ? -1 : b.type === 'start' ? 1 : 0));

  // Per-place time totals
  const locationSpans = [];
  const startEvent = events.find(e => e.type === 'start');
  let currentLoc = startEvent.location;
  let spanStart = dayStartTst;

  for (const ev of events) {
    if (ev.type === 'poi') {
      locationSpans.push({ location: currentLoc, start: spanStart, end: ev.tst });
      currentLoc = ev.location;
      spanStart = ev.tst;
    } else if (ev.type === 'visit') {
      locationSpans.push({ location: currentLoc, start: spanStart, end: ev.tst });
      currentLoc = ev.visitType === 'visit_started' ? ev.address : 'Roaming';
      spanStart = ev.tst;
    }
  }
  locationSpans.push({ location: currentLoc, start: spanStart, end: dayEndTst });

  const totals = {};
  for (const span of locationSpans) {
    totals[span.location] = (totals[span.location] || 0) + (span.end - span.start);
  }
  const locationTotals = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  // Per-activity-state time totals
  let activityTotals = null;
  if (activity) {
    const activitySpans = [];
    let currentAct = events[0].activity || events[0].state || 'UNKNOWN';
    let actSpanStart = dayStartTst;

    for (const ev of events) {
      if (ev.type === 'activity') {
        activitySpans.push({ state: currentAct, start: actSpanStart, end: ev.tst });
        currentAct = ev.state;
        actSpanStart = ev.tst;
      }
    }
    activitySpans.push({ state: currentAct, start: actSpanStart, end: dayEndTst });

    const actTotals = {};
    for (const span of activitySpans) {
      actTotals[span.state] = (actTotals[span.state] || 0) + (span.end - span.start);
    }
    activityTotals = Object.entries(actTotals).sort((a, b) => b[1] - a[1]);
  }

  return {
    tz,
    date,
    events,
    pointCount: dayEntries.length,
    dayStartTst,
    dayEndTst,
    // True while `date` is still in progress — dayEndTst is "now", not 11:59 PM.
    ongoing: nowTst < nextMidnightTst,
    distanceByState,
    locationSpans,
    locationTotals,
    activityTotals,
  };
}

export function formatDistance(meters, distanceUnit) {
  const useMiles = distanceUnit !== 'kilometers';
  const value = meters / (useMiles ? 1609.344 : 1000);
  const unit = useMiles ? 'mi' : 'km';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

/**
 * Generate a daily location/activity report.
 * Returns the report as a string, or null if no data found.
 */
export async function generateReport(date, config, db, timezone) {
  const day = await buildDayData(date, config, db, timezone);
  if (!day) return null;

  const { tz, events } = day;
  const lines = [];

  lines.push(`Location Report: ${date}`);
  lines.push(`Timezone: ${tz}  |  Data points: ${day.pointCount}`);
  lines.push('='.repeat(50));
  lines.push('');

  for (const ev of events) {
    const time = toLocalTime(ev.tst, tz).padEnd(10);

    switch (ev.type) {
      case 'start':
        lines.push(`${time}  ┌ Day starts — ${ev.location} (${fmtState(ev.activity)})`);
        break;
      case 'poi':
        if (ev.location === 'Roaming') {
          lines.push(`${time}  ├ Left ${ev.previousLocation}`);
        } else {
          lines.push(`${time}  ├ Arrived at ${ev.location}`);
        }
        break;
      case 'activity':
        lines.push(`${time}  │  → ${fmtState(ev.state)}`);
        break;
      case 'visit':
        if (ev.visitType === 'visit_started') {
          lines.push(`${time}  ├ Visited ${ev.address}`);
        } else if (ev.visitType === 'visit_ended') {
          lines.push(`${time}  ├ Left ${ev.address} (${ev.duration_minutes}m visit)`);
        }
        break;
      case 'end':
        lines.push(`${time}  └ Day ends — ${ev.location} (${fmtState(ev.activity)})`);
        break;
    }
  }

  // Location summary
  lines.push('');
  lines.push('Location Summary');
  lines.push('-'.repeat(30));

  for (const [loc, secs] of day.locationTotals) {
    lines.push(`  ${loc.padEnd(20)} ${formatDuration(secs)}`);
  }

  // Activity summary
  if (day.activityTotals) {
    lines.push('');
    lines.push('Activity Summary');
    lines.push('-'.repeat(30));

    for (const [state, secs] of day.activityTotals) {
      let line = `  ${fmtState(state).padEnd(20)} ${formatDuration(secs)}`;
      if (state === 'DRIVING' && day.distanceByState.DRIVING) {
        line += `  (${formatDistance(day.distanceByState.DRIVING, config.distance_unit)})`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

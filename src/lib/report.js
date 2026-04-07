import { createPOIDetector, haversineDistance } from './poi.js';
import { createActivityDetector } from './activity.js';
import { createVisitDetector } from './visit.js';
import { reverseGeocode } from './geocode.js';

// --- Helpers ---

function toLocalDate(tst, tz) {
  return new Date(tst * 1000).toLocaleDateString('en-CA', { timeZone: tz });
}

function toLocalTime(tst, tz) {
  return new Date(tst * 1000).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtState(s) {
  if (!s || s === 'N/A') return s;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function adjacentDate(dateStr, offset) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
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
 * Generate a daily location/activity report.
 * Returns the report as a string, or null if no data found.
 */
export async function generateReport(date, config, db, timezone) {
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

  // Process through detectors
  const poi = createPOIDetector(config);
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

  const effectiveTst = createStaleTstTracker();

  for (const e of seedEntries) {
    const tst = effectiveTst(e);
    poi.detect(e.lat, e.lon, tst);
    if (activity) activity.update(e.lat, e.lon, tst, e.vel);
    if (visit) {
      const poiLoc = poi.resolveLocation(e.lat, e.lon);
      const actState = activity?.getState() ?? 'UNKNOWN';
      visit.processPoint({ lat: e.lat, lon: e.lon, tst }, poiLoc, actState);
    }
  }

  const events = [];
  let prevPoint = null;
  let trackingState = activity?.getState() ?? null;
  const distanceByState = {};

  events.push({
    tst: dayEntries[0].tst,
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
      const poiLoc = poi.resolveLocation(e.lat, e.lon);
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

  events.push({
    tst: dayEntries[dayEntries.length - 1].tst,
    type: 'end',
    location: poi.getLocation(),
    activity: activity?.getState() ?? 'N/A',
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

  // Build output
  const lines = [];

  lines.push(`Location Report: ${date}`);
  lines.push(`Timezone: ${tz}  |  Data points: ${dayEntries.length}`);
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

  const locationSpans = [];
  const startEvent = events.find(e => e.type === 'start');
  let currentLoc = startEvent.location;
  let spanStart = dayEntries[0].tst;

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
  locationSpans.push({ location: currentLoc, start: spanStart, end: dayEntries[dayEntries.length - 1].tst });

  const totals = {};
  for (const span of locationSpans) {
    totals[span.location] = (totals[span.location] || 0) + (span.end - span.start);
  }

  for (const [loc, secs] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${loc.padEnd(20)} ${formatDuration(secs)}`);
  }

  // Activity summary
  if (activity) {
    lines.push('');
    lines.push('Activity Summary');
    lines.push('-'.repeat(30));

    const activitySpans = [];
    let currentAct = events[0].activity || events[0].state || 'UNKNOWN';
    let actSpanStart = dayEntries[0].tst;

    for (const ev of events) {
      if (ev.type === 'activity') {
        activitySpans.push({ state: currentAct, start: actSpanStart, end: ev.tst });
        currentAct = ev.state;
        actSpanStart = ev.tst;
      }
    }
    activitySpans.push({ state: currentAct, start: actSpanStart, end: dayEntries[dayEntries.length - 1].tst });

    const actTotals = {};
    for (const span of activitySpans) {
      actTotals[span.state] = (actTotals[span.state] || 0) + (span.end - span.start);
    }

    for (const [state, secs] of Object.entries(actTotals).sort((a, b) => b[1] - a[1])) {
      let line = `  ${fmtState(state).padEnd(20)} ${formatDuration(secs)}`;
      if (state === 'DRIVING' && distanceByState.DRIVING) {
        const useMiles = config.distance_unit !== 'kilometers';
        const value = distanceByState.DRIVING / (useMiles ? 1609.344 : 1000);
        const unit = useMiles ? 'mi' : 'km';
        line += `  (${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit})`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

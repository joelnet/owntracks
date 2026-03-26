import fs from 'node:fs';
import path from 'node:path';
import { createPOIDetector, haversineDistance } from './poi.js';
import { createActivityDetector } from './activity.js';

// --- Helpers ---

function readJSONL(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

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

/**
 * Generate a daily location/activity report.
 * Returns the report as a string, or null if no data found.
 */
export function generateReport(date, config, dataDir, timezone) {
  const tz = timezone || process.env.TZ || 'America/Los_Angeles';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const maxAccuracy = config.max_accuracy_m;

  // Load entries spanning the local date (up to 3 UTC files)
  const fileDates = [adjacentDate(date, -1), date, adjacentDate(date, 1)];
  const allEntries = fileDates.flatMap(d => readJSONL(path.join(dataDir, `${d}.jsonl`)));

  const locationEntries = allEntries
    .filter(e => e.type === 'location' && typeof e.lat === 'number' && typeof e.lon === 'number')
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

  for (const e of seedEntries) {
    poi.detect(e.lat, e.lon);
    if (activity) activity.update(e.lat, e.lon, e.tst, e.vel);
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
    // Accumulate distance to current activity state before updating
    if (prevPoint && trackingState && trackingState !== 'UNKNOWN') {
      const d = haversineDistance(prevPoint.lat, prevPoint.lon, e.lat, e.lon);
      distanceByState[trackingState] = (distanceByState[trackingState] || 0) + d;
    }

    const poiResult = poi.detect(e.lat, e.lon);
    const actResult = activity?.update(e.lat, e.lon, e.tst, e.vel);

    if (poiResult.changed) {
      events.push({
        tst: e.tst,
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
        tst: e.tst,
        type: 'activity',
        state: actResult.state,
        previousState: actResult.previousState,
      });
    }

    prevPoint = { lat: e.lat, lon: e.lon };
  }

  events.push({
    tst: dayEntries[dayEntries.length - 1].tst,
    type: 'end',
    location: poi.getLocation(),
    activity: activity?.getState() ?? 'N/A',
  });

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
  let currentLoc = events[0].location;
  let spanStart = dayEntries[0].tst;

  for (const ev of events) {
    if (ev.type === 'poi') {
      locationSpans.push({ location: currentLoc, start: spanStart, end: ev.tst });
      currentLoc = ev.location;
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
        const useMiles = config.distance_unit === 'mi' || config.distance_unit === undefined;
        const value = distanceByState.DRIVING / (useMiles ? 1609.344 : 1000);
        const unit = useMiles ? 'mi' : 'km';
        line += `  (${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit})`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

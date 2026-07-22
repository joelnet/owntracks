import fs from 'node:fs';
import path from 'node:path';
import * as log from './logger.js';
import {
  buildDayData,
  toLocalTime,
  formatDuration,
  formatDistance,
  fmtState,
  adjacentDate,
  localMidnightTst,
} from './report.js';

const DEBOUNCE_MS = 5000;
const KUMA_TIMEOUT_MS = 30_000;
// Finalize yesterday's file a few minutes after midnight so late-arriving
// points (phone upload lag) still land in the right day.
const MIDNIGHT_GRACE_MS = 5 * 60 * 1000;

function todayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

// "Tuesday, July 21, 2026" from a YYYY-MM-DD string. Anchor at noon UTC and
// format in UTC so the calendar date can't shift across timezones.
function longDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Collapse the day's events into one stay per place: { location, start, end }.
// Not derived from day.locationSpans — that walk lets a visit_ended sorted
// after a same-timestamp POI arrival flip the location back to Roaming, eating
// the rest of the day. Here a visit_ended can only close a visit stay.
function buildStays(day) {
  const stays = [];
  let open = null; // { location, start, kind: 'poi' | 'visit' }

  const close = (tst) => {
    if (open) {
      stays.push({ location: open.location, start: open.start, end: tst });
      open = null;
    }
  };

  for (const ev of day.events) {
    if (ev.type === 'start') {
      if (ev.location !== 'Roaming') {
        open = { location: ev.location, start: day.dayStartTst, kind: 'poi' };
      }
    } else if (ev.type === 'poi') {
      close(ev.tst);
      if (ev.location !== 'Roaming') {
        open = { location: ev.location, start: ev.tst, kind: 'poi' };
      }
    } else if (ev.type === 'visit') {
      if (ev.visitType === 'visit_started') {
        if (!open) open = { location: ev.address, start: ev.tst, kind: 'visit' };
      } else if (open?.kind === 'visit') {
        close(ev.tst);
      }
    }
  }
  close(day.dayEndTst);

  // Drop zero-length stays; merge back-to-back stays at the same place.
  const merged = [];
  for (const stay of stays) {
    if (stay.end <= stay.start) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.location === stay.location && prev.end === stay.start) {
      prev.end = stay.end;
    } else {
      merged.push(stay);
    }
  }
  return merged;
}

export function renderDailyNote(day, config) {
  const { tz, date } = day;
  const lines = [];

  lines.push(`# ${longDate(date)}`);
  lines.push('');

  // Home (or anything else in journal.exclude) is the baseline, not a stop
  // worth logging — the journal lists only places gone to.
  const excluded = new Set(config.journal?.exclude ?? []);
  const allStays = buildStays(day);
  const stays = allStays.filter(s => !excluded.has(s.location));
  const timeline = [];
  const allDayBaseline = !day.ongoing && allStays.length === 1 &&
    excluded.has(allStays[0].location) &&
    allStays[0].start === day.dayStartTst && allStays[0].end === day.dayEndTst;

  if (allDayBaseline) {
    timeline.push(`- At **${allStays[0].location}** all day`);
  } else {
    for (const stay of stays) {
      const from = toLocalTime(stay.start, tz);
      const dur = ` _(${formatDuration(stay.end - stay.start)})_`;
      if (day.ongoing && stay.end === day.dayEndTst) {
        // Still there right now — an end time would read as a departure.
        timeline.push(`- **${stay.location}** since ${from}${dur}`);
      } else {
        timeline.push(`- **${stay.location}** from ${from} to ${toLocalTime(stay.end, tz)}${dur}`);
      }
    }
  }
  lines.push(...timeline);

  // Day totals: walking and driving only.
  const summary = [];
  for (const state of ['WALKING', 'DRIVING']) {
    const entry = (day.activityTotals ?? []).find(([s]) => s === state);
    if (!entry) continue;
    const meters = day.distanceByState[state];
    // Below ~100 m the distance would render as "0.0 mi" — omit it.
    const dist = meters > 100 ? ` · ${formatDistance(meters, config.distance_unit)}` : '';
    summary.push(`- **${fmtState(state)}:** ${formatDuration(entry[1])}${dist}`);
  }
  if (summary.length) {
    if (timeline.length) lines.push('');
    lines.push(...summary);
  }

  lines.push('');
  return lines.join('\n');
}

export function createJournal({
  config,
  db,
  kumaPushUrl = process.env.UPTIME_KUMA_JOURNAL_PUSH_URL,
  fetchImpl = globalThis.fetch,
}) {
  const journalConfig = config.journal;
  const tz = journalConfig.timezone || process.env.TZ || 'America/Los_Angeles';
  const dir = journalConfig.dir;

  let debounceTimer = null;
  let midnightTimer = null;

  // Learned POIs change during the day (new visits), so re-merge them from
  // the DB on every write — same merge the Discord /location-report does.
  function mergedConfig() {
    const merged = { ...config, poi: { ...config.poi, locations: [...config.poi.locations] } };
    const learned = db.prepare('SELECT * FROM learned_pois').all();
    for (const poi of learned) {
      if (!merged.poi.locations.some(l => l.lat === poi.lat && l.lon === poi.lon)) {
        merged.poi.locations.push(poi);
      }
    }
    return merged;
  }

  async function writeDay(date) {
    const day = await buildDayData(date, mergedConfig(), db, tz);
    if (!day) return null;

    const md = renderDailyNote(day, config);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${date}-location.md`);
    // Write-then-rename so vault sync clients never see a half-written note.
    const tmp = path.join(dir, `.${date}-location.md.tmp`);
    fs.writeFileSync(tmp, md);
    fs.renameSync(tmp, target);
    return target;
  }

  function writeToday() {
    return writeDay(todayInTz(tz))
      .then(p => { if (p) log.info(`Journal updated: ${p}`); })
      .catch(err => log.error(`Journal write failed: ${err.message}`));
  }

  function scheduleUpdate() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      writeToday();
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  async function pushKuma(date) {
    if (!kumaPushUrl) return;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for Kuma heartbeat');

    const response = await fetchImpl(kumaPushUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(KUMA_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Kuma heartbeat returned HTTP ${response.status}`);
    }
    await response.text?.();
    log.info(`Journal Kuma heartbeat sent for ${date}`);
  }

  async function runMidnightFinalize(today = todayInTz(tz)) {
    const date = adjacentDate(today, -1);
    const target = await writeDay(date);
    if (!target) {
      throw new Error(`No location data for ${date}; journal was not finalized`);
    }

    // Open today's note if the phone has already uploaded an after-midnight
    // point, then report success only after all vault writes have completed.
    await writeDay(today);
    await pushKuma(date);
    return target;
  }

  function scheduleMidnightFinalize() {
    const nextMidnightMs = localMidnightTst(adjacentDate(todayInTz(tz), 1), tz) * 1000;
    const delay = Math.max(nextMidnightMs - Date.now() + MIDNIGHT_GRACE_MS, MIDNIGHT_GRACE_MS);
    midnightTimer = setTimeout(async () => {
      const today = todayInTz(tz);
      try {
        // Seal yesterday's note (day-end becomes 11:59 PM) and open today's.
        const target = await runMidnightFinalize(today);
        log.info(`Journal finalized: ${target}`);
      } catch (err) {
        log.error(`Journal midnight finalization failed: ${err.message}`);
      }
      scheduleMidnightFinalize();
    }, delay);
    midnightTimer.unref?.();
  }

  function start() {
    // Self-heal on boot: the server may have been down across an update or
    // midnight, so rewrite yesterday and today from the DB.
    const today = todayInTz(tz);
    writeDay(adjacentDate(today, -1))
      .catch(err => log.error(`Journal write failed: ${err.message}`));
    writeToday();
    scheduleMidnightFinalize();
  }

  function stop() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (midnightTimer) clearTimeout(midnightTimer);
    debounceTimer = null;
    midnightTimer = null;
  }

  return { writeDay, runMidnightFinalize, scheduleUpdate, start, stop };
}

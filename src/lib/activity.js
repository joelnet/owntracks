import { haversineDistance } from './poi.js';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function createActivityDetector(config) {
  const { dwell_threshold_minutes, walking_max_kmh, driving_min_kmh, window_size,
          min_transition_seconds = 0, min_point_interval_seconds = 0,
          stationary_max_spread_m = 300 } = config;
  let window = [];
  let currentState = 'UNKNOWN';
  let dwellStart = null;
  let pendingState = null;
  let pendingCount = 0;
  let pendingStartTime = null;

  function computeMedianSpeed() {
    const speeds = [];
    for (let i = 0; i < window.length - 1; i++) {
      const p1 = window[i], p2 = window[i + 1];
      const timeDelta = p2.timestamp - p1.timestamp;
      if (timeDelta <= 0) continue;
      // Phone-reported velocity (Doppler-based) is reliable at any interval.
      // vel >= 0 means the phone has a measurement (including zero = stationary).
      // vel < 0 or absent means unavailable — fall back to GPS-position-derived speed.
      if (typeof p2.vel === 'number' && p2.vel >= 0) {
        speeds.push(p2.vel);
      } else if (timeDelta >= min_point_interval_seconds) {
        const dist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
        speeds.push((dist / timeDelta) * 3.6);
      }
    }
    return speeds.length > 0 ? median(speeds) : null;
  }

  function classify(medianSpeed, timestamp) {
    if (medianSpeed >= driving_min_kmh) { dwellStart = null; return 'DRIVING'; }
    if (currentState === 'DRIVING' && medianSpeed >= walking_max_kmh) { dwellStart = null; return 'DRIVING'; }
    if (medianSpeed >= walking_max_kmh) { dwellStart = null; return 'WALKING'; }
    // Already stationary: low speed keeps us stationary. Dwell threshold
    // gates *entering* STATIONARY, not maintaining it across data gaps.
    if (currentState === 'STATIONARY') return 'STATIONARY';
    if (dwellStart === null) dwellStart = timestamp;
    if (timestamp - dwellStart >= dwell_threshold_minutes * 60) return 'STATIONARY';
    return 'WALKING';
  }

  return {
    update(lat, lon, timestamp, vel) {
      // Detect data gap: no updates for > dwell_threshold means device was stationary
      const lastTimestamp = window.length > 0 ? window[window.length - 1].timestamp : null;
      let gapTransition = null;

      if (lastTimestamp !== null && (timestamp - lastTimestamp) > dwell_threshold_minutes * 60) {
        if (currentState !== 'STATIONARY' && currentState !== 'UNKNOWN') {
          gapTransition = {
            state: 'STATIONARY',
            previousState: currentState,
            timestamp: lastTimestamp + dwell_threshold_minutes * 60,
          };
        }
        currentState = 'STATIONARY';
        window = [];
        dwellStart = null;
        pendingState = null;
        pendingCount = 0;
        pendingStartTime = null;
      }

      const point = { lat, lon, timestamp, vel };
      window.push(point);
      window.sort((a, b) => a.timestamp - b.timestamp);
      if (window.length > window_size) window.shift();

      if (window.length < window_size)
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false, gapTransition };

      let medianSpeed = computeMedianSpeed();
      if (medianSpeed === null)
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false, gapTransition };

      const first = window[0], last = window[window.length - 1];
      const windowTime = last.timestamp - first.timestamp;

      // Bimodal-jitter guard: phones with weak GPS sometimes oscillate between
      // a small set of cached fixes while stationary (e.g. indoors). Pairwise
      // GPS speed across the window registers as movement even though the
      // device is sitting still. When no point in the window has a reported
      // velocity and the entire window fits within a small bounding box,
      // override medianSpeed to 0 so the classifier sees the dwell.
      if (windowTime > 0 && medianSpeed >= walking_max_kmh) {
        const allVelMissing = window.every(p => typeof p.vel !== 'number' || p.vel < 0);
        if (allVelMissing) {
          let maxSpread = 0;
          for (let i = 0; i < window.length - 1; i++) {
            for (let j = i + 1; j < window.length; j++) {
              const d = haversineDistance(window[i].lat, window[i].lon, window[j].lat, window[j].lon);
              if (d > maxSpread) maxSpread = d;
            }
          }
          if (maxSpread < stationary_max_spread_m) medianSpeed = 0;
        }
      }

      // Displacement sanity check: if window endpoints show the device hasn't
      // actually moved, high median speed is from GPS artifacts, not real driving.
      // Check displacement when median vel is low OR any point reports vel=0
      // (phone confirmed stationary). This catches GPS glitches that produce both
      // position AND velocity spikes while some points still correctly report vel=0.
      // Legitimate driving (including U-turns) is preserved because all window
      // points have consistently high vel, so neither condition triggers.
      if (windowTime > 0 && medianSpeed >= driving_min_kmh) {
        const velValues = window.map(p =>
          typeof p.vel === 'number' && p.vel >= 0 ? p.vel : 0);
        if (median(velValues) < walking_max_kmh || velValues.includes(0)) {
          const displacement = haversineDistance(first.lat, first.lon, last.lat, last.lon);
          const displacementSpeed = (displacement / windowTime) * 3.6;
          if (displacementSpeed < walking_max_kmh) {
            medianSpeed = displacementSpeed;
          }
        }
      }

      // Reverse displacement check: if phone velocity reports slow/stationary
      // but GPS positions show significant movement, trust GPS displacement.
      // Catches vel=0 artifacts during driving and brief stops (stop signs,
      // red lights) that shouldn't break a continuous drive. Require every
      // adjacent pair to show motion before trusting — a one-off GPS spike
      // produces large endpoint displacement but mostly-zero pair distances.
      if (windowTime > 0 && medianSpeed < walking_max_kmh) {
        const displacement = haversineDistance(first.lat, first.lon, last.lat, last.lon);
        const displacementSpeed = (displacement / windowTime) * 3.6;
        if (displacementSpeed >= driving_min_kmh) {
          let movingPairs = 0;
          for (let i = 0; i < window.length - 1; i++) {
            const dt = window[i + 1].timestamp - window[i].timestamp;
            if (dt <= 0) continue;
            const dist = haversineDistance(window[i].lat, window[i].lon, window[i + 1].lat, window[i + 1].lon);
            if ((dist / dt) * 3.6 >= walking_max_kmh) movingPairs++;
          }
          if (movingPairs === window.length - 1) medianSpeed = displacementSpeed;
        }
      }

      const latestTimestamp = window[window.length - 1].timestamp;
      const candidate = classify(medianSpeed, latestTimestamp);

      if (candidate === pendingState) {
        pendingCount++;
      } else {
        pendingState = candidate;
        pendingCount = 1;
        pendingStartTime = latestTimestamp;
      }

      if (currentState === 'UNKNOWN' && pendingCount >= 2) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: false, state: currentState, previousState, initialClassification: true, gapTransition };
      }

      const isMovementFlip = (currentState === 'DRIVING' && pendingState === 'WALKING') ||
                             (currentState === 'WALKING' && pendingState === 'DRIVING');
      const timeReqMet = !isMovementFlip || (latestTimestamp - pendingStartTime >= min_transition_seconds);

      if (pendingCount >= 2 && pendingState !== currentState && timeReqMet) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: true, state: currentState, previousState, initialClassification: false, gapTransition };
      }
      return { changed: false, state: currentState, previousState: currentState, initialClassification: false, gapTransition };
    },
    getState() { return currentState; },
    setState(savedState) {
      if (savedState && typeof savedState === 'object') {
        currentState = savedState.currentState || 'UNKNOWN';
        window = Array.isArray(savedState.window) ? savedState.window : [];
        dwellStart = savedState.dwellStart ?? null;
        pendingState = savedState.pendingState ?? null;
        pendingCount = savedState.pendingCount ?? 0;
        pendingStartTime = savedState.pendingStartTime ?? null;
      } else {
        currentState = 'UNKNOWN';
        window = [];
        dwellStart = null;
        pendingState = null;
        pendingCount = 0;
        pendingStartTime = null;
      }
    },
    getFullState() { return { currentState, window, dwellStart, pendingState, pendingCount, pendingStartTime }; },
  };
}

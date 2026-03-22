import { haversineDistance } from './poi.js';

function sanitizeVel(vel) {
  return typeof vel === 'number' && vel > 0 ? vel : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function createActivityDetector(config) {
  const { dwell_threshold_minutes, walking_max_kmh, driving_min_kmh, window_size } = config;
  let window = [];
  let currentState = 'UNKNOWN';
  let dwellStart = null;
  let pendingState = null;
  let pendingCount = 0;

  function computeMedianSpeed() {
    const speeds = [];
    for (let i = 0; i < window.length - 1; i++) {
      const p1 = window[i], p2 = window[i + 1];
      const timeDelta = p2.timestamp - p1.timestamp;
      if (timeDelta <= 0) continue;
      const dist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
      const calculatedKmh = (dist / timeDelta) * 3.6;
      const vel = sanitizeVel(p2.vel);
      speeds.push(Math.max(calculatedKmh, vel));
    }
    return speeds.length > 0 ? median(speeds) : null;
  }

  function classify(medianSpeed, timestamp) {
    if (medianSpeed >= driving_min_kmh) { dwellStart = null; return 'DRIVING'; }
    if (medianSpeed >= walking_max_kmh) { dwellStart = null; return 'WALKING'; }
    if (dwellStart === null) dwellStart = timestamp;
    if (timestamp - dwellStart >= dwell_threshold_minutes * 60) return 'STATIONARY';
    return 'WALKING';
  }

  return {
    update(lat, lon, timestamp, vel) {
      const point = { lat, lon, timestamp, vel };
      window.push(point);
      window.sort((a, b) => a.timestamp - b.timestamp);
      if (window.length > window_size) window.shift();

      if (window.length < window_size)
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false };

      const medianSpeed = computeMedianSpeed();
      if (medianSpeed === null)
        return { changed: false, state: currentState, previousState: currentState, initialClassification: false };

      const latestTimestamp = window[window.length - 1].timestamp;
      const candidate = classify(medianSpeed, latestTimestamp);

      if (candidate === pendingState) pendingCount++;
      else { pendingState = candidate; pendingCount = 1; }

      if (currentState === 'UNKNOWN' && pendingCount >= 2) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: false, state: currentState, previousState, initialClassification: true };
      }
      if (pendingCount >= 2 && pendingState !== currentState) {
        const previousState = currentState;
        currentState = pendingState;
        return { changed: true, state: currentState, previousState, initialClassification: false };
      }
      return { changed: false, state: currentState, previousState: currentState, initialClassification: false };
    },
    getState() { return currentState; },
    setState(savedState) {
      if (savedState && typeof savedState === 'object') {
        currentState = savedState.currentState || 'UNKNOWN';
        window = Array.isArray(savedState.window) ? savedState.window : [];
        dwellStart = savedState.dwellStart ?? null;
        pendingState = savedState.pendingState ?? null;
        pendingCount = savedState.pendingCount ?? 0;
      }
    },
    getFullState() { return { currentState, window, dwellStart, pendingState, pendingCount }; },
  };
}

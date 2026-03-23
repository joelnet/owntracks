import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityDetector } from '../activity.js';

const BASE_CONFIG = {
  enabled: true, discord_notifications: true,
  dwell_threshold_minutes: 5, walking_max_kmh: 7,
  driving_min_kmh: 25, window_size: 3,
};

function makePoints(count, speedKmh, baseTime = 1000000) {
  const intervalSec = 30;
  const speedMs = speedKmh / 3.6;
  const distPerInterval = speedMs * intervalSec;
  const degreesPerMeter = 1 / 111195;
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: 0 + i * distPerInterval * degreesPerMeter,
      lon: 0, timestamp: baseTime + i * intervalSec, vel: speedKmh,
    });
  }
  return points;
}

function makeContinuousPoints(segments, baseTime = 1000000) {
  const intervalSec = 30;
  const degreesPerMeter = 1 / 111195;
  const points = [];
  let lat = 0;
  let t = baseTime;
  for (const { count, speedKmh } of segments) {
    for (let i = 0; i < count; i++) {
      points.push({ lat, lon: 0, timestamp: t, vel: speedKmh });
      lat += (speedKmh / 3.6) * intervalSec * degreesPerMeter;
      t += intervalSec;
    }
  }
  return points;
}

describe('activity detector', () => {
  describe('window management', () => {
    it('stays UNKNOWN until window is full', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(3, 50);
      // With window_size:3, first two points should not yet produce a classification
      const r1 = detector.update(pts[0].lat, pts[0].lon, pts[0].timestamp, pts[0].vel);
      assert.equal(r1.state, 'UNKNOWN');
      assert.equal(r1.changed, false);
      const r2 = detector.update(pts[1].lat, pts[1].lon, pts[1].timestamp, pts[1].vel);
      assert.equal(r2.state, 'UNKNOWN');
      assert.equal(r2.changed, false);
    });

    it('classifies on window_size-th point', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      // Feed 4 driving-speed points; by window_size-th (3rd) we should have a result,
      // and pendingCount will reach 2 on the 4th giving us a state
      const pts = makePoints(5, 50);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.notEqual(result.state, 'UNKNOWN');
    });

    it('sorts by timestamp for out-of-order points', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(4, 50);
      // Insert out of order: 3, 1, 2, 4
      detector.update(pts[2].lat, pts[2].lon, pts[2].timestamp, pts[2].vel);
      detector.update(pts[0].lat, pts[0].lon, pts[0].timestamp, pts[0].vel);
      detector.update(pts[1].lat, pts[1].lon, pts[1].timestamp, pts[1].vel);
      const r = detector.update(pts[3].lat, pts[3].lon, pts[3].timestamp, pts[3].vel);
      // Should not throw; state should be deterministic and not UNKNOWN after 4 driving points
      assert.notEqual(r.state, 'UNKNOWN');
    });
  });

  describe('speed classification', () => {
    it('classifies as DRIVING at 50km/h', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 50);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(result.state, 'DRIVING');
    });

    it('classifies as WALKING at 15km/h', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 15);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(result.state, 'WALKING');
    });

    it('classifies as STATIONARY at 0.5km/h with short dwell_threshold', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 0.01 };
      const detector = createActivityDetector(config);
      const pts = makePoints(5, 0.5);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(result.state, 'STATIONARY');
    });
  });

  describe('vel handling', () => {
    it('null vel uses calculated speed', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 50);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, null);
      }
      // Should still classify as DRIVING based on calculated distance/time
      assert.equal(result.state, 'DRIVING');
    });

    it('negative vel treated as 0', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 0.01 };
      const detector = createActivityDetector(config);
      // Use actual slow points so calculated speed is also low
      const pts = makePoints(5, 0.5);
      let result;
      for (const p of pts) {
        result = detector.update(p.lat, p.lon, p.timestamp, -10);
      }
      // negative vel treated as 0; calculated speed is ~0.5km/h => STATIONARY
      assert.equal(result.state, 'STATIONARY');
    });
  });

  describe('zero timeDelta', () => {
    it('skips pairs with identical timestamps', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const ts = 1000000;
      // Three points with the same timestamp — no valid pairs for speed calc
      const r1 = detector.update(0, 0, ts, 0);
      const r2 = detector.update(0.001, 0, ts, 0);
      const r3 = detector.update(0.002, 0, ts, 0);
      // medianSpeed will be null, so state stays UNKNOWN
      assert.equal(r3.state, 'UNKNOWN');
    });
  });

  describe('initial classification', () => {
    it('sets state from UNKNOWN and returns initialClassification:true exactly once', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(6, 50);
      const results = pts.map(p => detector.update(p.lat, p.lon, p.timestamp, p.vel));
      const initialResults = results.filter(r => r.initialClassification === true);
      assert.equal(initialResults.length, 1);
      assert.notEqual(detector.getState(), 'UNKNOWN');
    });

    it('initial classification result has changed:false', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(6, 50);
      let initialResult;
      for (const p of pts) {
        const r = detector.update(p.lat, p.lon, p.timestamp, p.vel);
        if (r.initialClassification) initialResult = r;
      }
      assert.ok(initialResult, 'should have an initialClassification result');
      assert.equal(initialResult.changed, false);
      assert.equal(initialResult.previousState, 'UNKNOWN');
    });
  });

  describe('state transitions', () => {
    it('DRIVING->WALKING returns changed:true with correct previousState', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      // First establish DRIVING state
      const drivingPts = makePoints(5, 50);
      for (const p of drivingPts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');

      // Now feed WALKING speed points; need pendingCount >= 2 to trigger change
      const baseTime = drivingPts[drivingPts.length - 1].timestamp + 30;
      const walkingPts = makePoints(5, 15, baseTime);
      let changedResult;
      for (const p of walkingPts) {
        const r = detector.update(p.lat, p.lon, p.timestamp, p.vel);
        if (r.changed) changedResult = r;
      }
      assert.ok(changedResult, 'should have a changed:true result');
      assert.equal(changedResult.state, 'WALKING');
      assert.equal(changedResult.previousState, 'DRIVING');
    });
  });

  describe('min_transition_seconds', () => {
    it('blocks DRIVING->WALKING flip when time requirement not met', () => {
      const config = { ...BASE_CONFIG, min_transition_seconds: 120 };
      const detector = createActivityDetector(config);
      // Establish DRIVING
      const drivingPts = makePoints(5, 50);
      for (const p of drivingPts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');

      // Feed walking-speed points for only 60s (below 120s threshold)
      const baseTime = drivingPts[drivingPts.length - 1].timestamp + 30;
      const walkingPts = makePoints(3, 15, baseTime); // 3 pts * 30s = 60s
      for (const p of walkingPts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');
    });

    it('allows DRIVING->WALKING after time requirement is met', () => {
      const config = { ...BASE_CONFIG, min_transition_seconds: 120 };
      const detector = createActivityDetector(config);

      // Build a continuous path: 5 driving points then 8 walking points
      const pts = makeContinuousPoints([
        { count: 5, speedKmh: 50 },
        { count: 8, speedKmh: 15 },
      ]);

      let changedResult;
      for (const p of pts) {
        const r = detector.update(p.lat, p.lon, p.timestamp, p.vel);
        if (r.changed) changedResult = r;
      }
      assert.ok(changedResult, 'should transition after time requirement met');
      assert.equal(changedResult.state, 'WALKING');
    });

    it('resets pending timer when classification oscillates', () => {
      const config = { ...BASE_CONFIG, min_transition_seconds: 120 };
      const detector = createActivityDetector(config);
      // Establish DRIVING
      const drivingPts = makePoints(5, 50);
      for (const p of drivingPts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }

      let baseTime = drivingPts[drivingPts.length - 1].timestamp + 30;
      // Oscillate: walking, driving, walking — timer resets each flip
      for (let i = 0; i < 3; i++) {
        const walk = makePoints(2, 15, baseTime);
        for (const p of walk) detector.update(p.lat, p.lon, p.timestamp, p.vel);
        baseTime = walk[walk.length - 1].timestamp + 30;

        const drive = makePoints(2, 50, baseTime);
        for (const p of drive) detector.update(p.lat, p.lon, p.timestamp, p.vel);
        baseTime = drive[drive.length - 1].timestamp + 30;
      }
      // Despite many walking points total, oscillation prevents transition
      assert.equal(detector.getState(), 'DRIVING');
    });

    it('does not apply to STATIONARY->WALKING transitions', () => {
      const config = { ...BASE_CONFIG, min_transition_seconds: 120 };
      const detector = createActivityDetector(config);
      // Directly set state to STATIONARY to avoid dwell timer complications
      detector.setState({ currentState: 'STATIONARY', window: [], dwellStart: null,
        pendingState: null, pendingCount: 0, pendingStartTime: null });

      // Feed walking-speed points — should transition without waiting 120s
      const walkingPts = makePoints(4, 15);
      let changedResult;
      for (const p of walkingPts) {
        const r = detector.update(p.lat, p.lon, p.timestamp, p.vel);
        if (r.changed) changedResult = r;
      }
      assert.ok(changedResult, 'should transition without time requirement');
      assert.equal(changedResult.state, 'WALKING');
    });

    it('persists pendingStartTime in state round-trip', () => {
      const config = { ...BASE_CONFIG, min_transition_seconds: 120 };
      const detector1 = createActivityDetector(config);
      const pts = makePoints(5, 50);
      for (const p of pts) {
        detector1.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      const state = detector1.getFullState();
      assert.ok('pendingStartTime' in state);

      const detector2 = createActivityDetector(config);
      detector2.setState(state);
      assert.deepEqual(detector2.getFullState(), state);
    });
  });

  describe('debounce', () => {
    it('single slow point does not change DRIVING state', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      // Establish DRIVING
      const drivingPts = makePoints(5, 50);
      for (const p of drivingPts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.equal(detector.getState(), 'DRIVING');

      // One slow point should not change state (pendingCount only 1)
      const lastTs = drivingPts[drivingPts.length - 1].timestamp + 30;
      const slowPt = makePoints(1, 5, lastTs)[0];
      const r = detector.update(slowPt.lat, slowPt.lon, slowPt.timestamp, slowPt.vel);
      assert.equal(r.changed, false);
      assert.equal(detector.getState(), 'DRIVING');
    });
  });

  describe('dwell timer', () => {
    it('does not go stationary before threshold (10min threshold, ~5.5min of slow points)', () => {
      // 12 points at 30s intervals = 5.5min elapsed, threshold is 10min
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 10, window_size: 3 };
      const detector = createActivityDetector(config);
      // First establish WALKING state
      const walkPts = makePoints(12, 2, 1000000);
      let lastResult;
      for (const p of walkPts) {
        lastResult = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      // 12 points at 30s intervals = 330s = 5.5min elapsed, below 10min threshold
      // Should be WALKING, not STATIONARY
      assert.notEqual(detector.getState(), 'STATIONARY');
    });

    it('goes stationary after threshold (2min threshold, ~4.5min of slow points)', () => {
      // 10 points at 30s intervals = 4.5min elapsed, threshold is 2min
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 2, window_size: 3 };
      const detector = createActivityDetector(config);
      const slowPts = makePoints(10, 1, 1000000);
      let lastResult;
      for (const p of slowPts) {
        lastResult = detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      // Should have reached STATIONARY since 4.5min > 2min threshold
      assert.equal(detector.getState(), 'STATIONARY');
    });

    it('resets dwell timer when speed rises then falls again', () => {
      const config = { ...BASE_CONFIG, dwell_threshold_minutes: 1, window_size: 3 };
      const detector = createActivityDetector(config);
      // Phase 1: slow points to start dwell timer (but not enough to go STATIONARY)
      const slow1 = makePoints(4, 1, 1000000);
      for (const p of slow1) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      // Phase 2: fast points to reset dwell timer
      const fast = makePoints(4, 50, slow1[slow1.length - 1].timestamp + 30);
      for (const p of fast) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      // Phase 3: slow points again — dwell timer should restart from now
      // With 1min threshold = 60s, and points at 30s intervals, need > 2 intervals
      // Use only 3 slow points (60s elapsed) — right at boundary, start of dwell
      const slow2BaseTime = fast[fast.length - 1].timestamp + 30;
      const slow2 = makePoints(3, 1, slow2BaseTime);
      for (const p of slow2) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      // 60s elapsed since timer reset — exactly at threshold, not yet STATIONARY
      // (dwellStart is set when first slow point arrives, 60s = threshold, need > threshold)
      // So still WALKING (timer restarted)
      assert.notEqual(detector.getState(), 'STATIONARY');
    });
  });

  describe('state persistence', () => {
    it('getFullState returns complete state object', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 50);
      for (const p of pts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      const state = detector.getFullState();
      assert.ok('currentState' in state);
      assert.ok('window' in state);
      assert.ok('dwellStart' in state);
      assert.ok('pendingState' in state);
      assert.ok('pendingCount' in state);
      assert.ok(Array.isArray(state.window));
    });

    it('setState round-trip restores full state', () => {
      const detector1 = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 50);
      for (const p of pts) {
        detector1.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      const savedState = detector1.getFullState();

      const detector2 = createActivityDetector(BASE_CONFIG);
      detector2.setState(savedState);
      assert.equal(detector2.getState(), detector1.getState());
      assert.deepEqual(detector2.getFullState(), savedState);
    });

    it('setState(null) resets to UNKNOWN', () => {
      const detector = createActivityDetector(BASE_CONFIG);
      const pts = makePoints(5, 50);
      for (const p of pts) {
        detector.update(p.lat, p.lon, p.timestamp, p.vel);
      }
      assert.notEqual(detector.getState(), 'UNKNOWN');
      detector.setState(null);
      assert.equal(detector.getState(), 'UNKNOWN');
    });
  });
});

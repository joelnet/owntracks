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
});

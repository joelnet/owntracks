import { haversineDistance } from './poi.js';

export function createVisitDetector(config, savedState) {
  const {
    containment_radius_m,
    min_dwell_minutes,
    exit_timeout_minutes,
    learn_pois,
    learned_poi_radius_m,
  } = config;

  let session = null;
  let learnedPois = [];

  if (savedState && savedState.active) {
    session = {
      active: savedState.active,
      anchor: { ...savedState.anchor },
      centroid: { ...savedState.centroid },
      point_count: savedState.point_count,
      started_at: savedState.started_at,
      triggered: savedState.triggered,
      last_outside_at: savedState.last_outside_at,
    };
  }

  function openSession(lat, lon, tst) {
    session = {
      active: true,
      anchor: { lat, lon },
      centroid: { lat, lon },
      point_count: 1,
      started_at: new Date(tst * 1000).toISOString(),
      triggered: false,
      last_outside_at: null,
    };
  }

  function closeSession(tst) {
    if (!session) return null;
    const wasTriggered = session.triggered;
    let event = null;
    if (wasTriggered) {
      const startMs = new Date(session.started_at).getTime();
      const endMs = tst * 1000;
      const durationMin = Math.round((endMs - startMs) / 60000);
      event = {
        type: 'visit_ended',
        centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
        started_at: session.started_at,
        ended_at: new Date(endMs).toISOString(),
        duration_minutes: durationMin,
      };
    }
    session = null;
    return event;
  }

  function learnPoi(centroid, tst) {
    const now = new Date(tst * 1000).toISOString();
    const existing = learnedPois.find(p =>
      haversineDistance(p.lat, p.lon, centroid.lat, centroid.lon) <= learned_poi_radius_m
    );
    if (existing) {
      existing.visit_count++;
      existing.last_visited_at = now;
      existing.lat += (centroid.lat - existing.lat) / existing.visit_count;
      existing.lon += (centroid.lon - existing.lon) / existing.visit_count;
    } else {
      learnedPois.push({
        name: `Unknown (${centroid.lat.toFixed(4)}, ${centroid.lon.toFixed(4)})`,
        lat: centroid.lat,
        lon: centroid.lon,
        radius_m: learned_poi_radius_m,
        discovered_at: now,
        visit_count: 1,
        last_visited_at: now,
      });
    }
  }

  function processPoint(point, poiResult, activityState) {
    const { lat, lon, tst } = point;

    // Close conditions (checked before accumulation)
    if (session) {
      if (poiResult !== 'Roaming') return closeSession(tst);
      if (activityState === 'DRIVING') return closeSession(tst);
    }

    // Open condition
    if (!session && poiResult === 'Roaming' && activityState !== 'DRIVING') {
      openSession(lat, lon, tst);
      return null;
    }

    if (!session) return null;

    // During session: check containment
    const dist = haversineDistance(lat, lon, session.anchor.lat, session.anchor.lon);

    if (dist <= containment_radius_m) {
      session.last_outside_at = null;
      session.point_count++;
      session.centroid.lat += (lat - session.centroid.lat) / session.point_count;
      session.centroid.lon += (lon - session.centroid.lon) / session.point_count;

      if (!session.triggered) {
        const startMs = new Date(session.started_at).getTime();
        const elapsedSec = (tst * 1000 - startMs) / 1000;
        if (elapsedSec >= min_dwell_minutes * 60) {
          session.triggered = true;
          if (learn_pois) {
            learnPoi(session.centroid, tst);
          }
          return {
            type: 'visit_started',
            centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
            started_at: session.started_at,
          };
        }
      }
    } else {
      if (session.last_outside_at === null) {
        session.last_outside_at = new Date(tst * 1000).toISOString();
      }
      const outsideStartMs = new Date(session.last_outside_at).getTime();
      const outsideSec = (tst * 1000 - outsideStartMs) / 1000;
      if (outsideSec >= exit_timeout_minutes * 60) {
        return closeSession(tst);
      }
    }

    return null;
  }

  return {
    processPoint,
    getState() {
      if (!session) return { active: false };
      return {
        active: session.active,
        anchor: { lat: session.anchor.lat, lon: session.anchor.lon },
        centroid: { lat: session.centroid.lat, lon: session.centroid.lon },
        point_count: session.point_count,
        started_at: session.started_at,
        triggered: session.triggered,
        last_outside_at: session.last_outside_at,
      };
    },
    getLearnedPois() {
      return learnedPois.map(p => ({ ...p }));
    },
    loadLearnedPois(pois) {
      learnedPois = pois.map(p => ({ ...p }));
    },
  };
}

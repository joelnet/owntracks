import { haversineDistance } from './poi.js';

export function createVisitDetector(config, savedState) {
  const {
    containment_radius_m,
    min_dwell_minutes,
    exit_timeout_minutes,
    learn_pois,
    learned_poi_radius_m,
    min_distance_from_known_poi_m = 0,
  } = config;

  let session = null;
  let learnedPois = [];
  // Known POIs (configured + previously learned) used as exclusion zones when
  // learning new ones. Prevents phantom POIs from being learned at network-
  // fallback coordinates that consistently appear near a real POI.
  let knownPois = [];
  // Previous processed point — used to detect "hidden stops" across data gaps.
  let prevPoint = null;

  if (savedState && savedState.active) {
    session = {
      active: savedState.active,
      anchor: { ...savedState.anchor },
      centroid: { ...savedState.centroid },
      point_count: savedState.point_count,
      started_at: savedState.started_at,
      triggered: savedState.triggered,
      suppressed: savedState.suppressed ?? false,
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

  function isNearKnownPoi(lat, lon) {
    if (min_distance_from_known_poi_m <= 0) return false;
    return knownPois.some(p => {
      const guard = (p.radius_m ?? 0) + min_distance_from_known_poi_m;
      return haversineDistance(p.lat, p.lon, lat, lon) <= guard;
    });
  }

  function closeSession(tst) {
    if (!session) return null;
    const emit = session.triggered && !session.suppressed;
    let event = null;
    if (emit) {
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
        address: null,
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
      if (poiResult !== 'Roaming') {
        const event = closeSession(tst);
        prevPoint = { lat, lon, tst, poi: poiResult };
        return event;
      }
      if (activityState === 'DRIVING') {
        const event = closeSession(tst);
        prevPoint = { lat, lon, tst, poi: poiResult };
        return event;
      }
    }

    // Hidden-stop detection: two consecutive Roaming points with a time gap
    // longer than the dwell threshold but a position gap smaller than the
    // containment radius indicate the user stopped during the gap (phone went
    // dark indoors / parked). Anchor a session retroactively at the pre-gap
    // point so dwell counts from the real stop start — otherwise the activity
    // state lingers at DRIVING and the post-gap point becomes the departure.
    if (!session && poiResult === 'Roaming' && prevPoint && prevPoint.poi === 'Roaming') {
      const gapSec = tst - prevPoint.tst;
      if (gapSec > min_dwell_minutes * 60) {
        const gapDist = haversineDistance(lat, lon, prevPoint.lat, prevPoint.lon);
        if (gapDist <= containment_radius_m) {
          openSession(prevPoint.lat, prevPoint.lon, prevPoint.tst);
        }
      }
    }

    // Open condition
    if (!session && poiResult === 'Roaming' && activityState !== 'DRIVING') {
      openSession(lat, lon, tst);
      prevPoint = { lat, lon, tst, poi: poiResult };
      return null;
    }

    if (!session) {
      prevPoint = { lat, lon, tst, poi: poiResult };
      return null;
    }

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
          // Suppress visit when the centroid sits inside a known POI's exclusion
          // zone — this is almost always a network-fallback / cached coordinate
          // and not a real visit.
          if (isNearKnownPoi(session.centroid.lat, session.centroid.lon)) {
            session.suppressed = true;
            return null;
          }
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
        const event = closeSession(tst);
        prevPoint = { lat, lon, tst, poi: poiResult };
        return event;
      }
    }

    prevPoint = { lat, lon, tst, poi: poiResult };
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
        suppressed: session.suppressed ?? false,
        last_outside_at: session.last_outside_at,
      };
    },
    getLearnedPois() {
      return learnedPois.map(p => ({ ...p }));
    },
    loadLearnedPois(pois) {
      learnedPois = pois.map(p => ({ ...p }));
    },
    // Append a single learned POI (e.g. one created on demand via Discord) to
    // the in-memory list so it survives the next persist, which rebuilds the
    // learned_pois table from this list (delete-all + reinsert).
    addLearnedPoi(poi) {
      learnedPois.push({ ...poi });
    },
    setKnownPois(pois) {
      knownPois = pois.map(p => ({ ...p }));
    },
    renameLearnedPoi(lat, lon, name) {
      const poi = learnedPois.find(p =>
        Math.abs(p.lat - lat) < 0.001 && Math.abs(p.lon - lon) < 0.001
      );
      if (poi) {
        poi.name = name;
        poi.address = name;
      }
    },
    // Replace the tenant list on a learned POI (multi-business anchor) so the
    // next persist — which rebuilds learned_pois from this in-memory list —
    // keeps it.
    setLearnedPoiTenants(lat, lon, tenants) {
      const poi = learnedPois.find(p =>
        Math.abs(p.lat - lat) < 0.001 && Math.abs(p.lon - lon) < 0.001
      );
      if (poi) poi.tenants = tenants.map(t => ({ ...t }));
    },
  };
}

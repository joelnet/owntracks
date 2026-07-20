const EARTH_RADIUS_M = 6_371_008;

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Normalize a POI definition into a flat list of anchor circles. A POI may be
// defined as a single point (lat/lon at the top level) or as multiple anchors
// via `points: [{lat, lon, radius_m?}, ...]`. Multi-anchor POIs let one
// logical place (e.g. Home) cover both its real coordinate and a phantom
// coordinate the phone repeatedly reports as a network-fallback location.
export function poiAnchors(poi, defaultRadius) {
  if (Array.isArray(poi.points) && poi.points.length > 0) {
    return poi.points.map(p => ({
      lat: p.lat,
      lon: p.lon,
      radius_m: p.radius_m ?? defaultRadius,
    }));
  }
  return [{
    lat: poi.lat,
    lon: poi.lon,
    radius_m: poi.radius_m ?? defaultRadius,
  }];
}

// Fixes arriving closer together than this (duplicate MQTT deliveries of the
// same physical fix) can't say anything about motion on their own.
const STATIONARY_MIN_GAP_S = 10;

export function createPOIDetector(config) {
  const {
    default_radius_m,
    locations,
    min_transition_points = 1,
    exit_extra_m = 0,
    min_transition_seconds = 0,
    immediate_arrival_stationary_points = 2,
    stationary_displacement_m = 15,
  } = config.poi;
  let lastLocation = 'Roaming';
  let pendingLocation = null;
  let pendingCount = 0;
  let pendingStartTime = null;
  // Consecutive stationary fixes resolving to the current pending location.
  // Resets whenever the pending location changes or a moving fix arrives.
  let stationaryCount = 0;
  // Previous fix seen by detect(), the reference for displacement-based
  // motion classification.
  let lastFix = null;

  // Classify a fix as 'stationary' | 'moving' | 'unknown'. Phone-reported
  // velocity wins when present. When absent, fall back to displacement from
  // the previous fix: OwnTracks Android >= 2.5.9 omits zero-valued fields
  // (per the OwnTracks JSON spec), so a parked phone sends no vel key at all
  // — but coarse network fixes mid-drive also omit vel, so small displacement
  // must confirm it. Fixes closer than STATIONARY_MIN_GAP_S apart are
  // 'unknown': they neither advance nor reset a stationary streak. Setting
  // stationary_displacement_m to 0 disables the displacement fallback
  // (used by the report replay to keep tuning baselines locked).
  function classifyMotion(lat, lon, tst, vel) {
    const prev = lastFix;
    lastFix = { lat, lon, tst };
    if (vel === 0) return 'stationary';
    if (typeof vel === 'number') return 'moving';
    if (!stationary_displacement_m) return 'unknown';
    if (!prev || typeof tst !== 'number' || typeof prev.tst !== 'number') return 'unknown';
    if (tst - prev.tst < STATIONARY_MIN_GAP_S) return 'unknown';
    return haversineDistance(lat, lon, prev.lat, prev.lon) <= stationary_displacement_m
      ? 'stationary'
      : 'moving';
  }

  function poiContains(poi, lat, lon, extraBuffer = 0) {
    for (const a of poiAnchors(poi, default_radius_m)) {
      if (haversineDistance(lat, lon, a.lat, a.lon) <= a.radius_m + extraBuffer) {
        return true;
      }
    }
    return false;
  }

  function resolveLocation(lat, lon) {
    // Hysteresis: if currently at a POI, use larger exit radius for that POI
    if (lastLocation !== 'Roaming') {
      const currentPoi = locations.find(p => p.name === lastLocation);
      if (currentPoi && poiContains(currentPoi, lat, lon, exit_extra_m)) {
        return lastLocation;
      }
    }

    // Check entry into any POI using normal radius
    for (const poi of locations) {
      if (poiContains(poi, lat, lon)) return poi.name;
    }
    return 'Roaming';
  }

  return {
    detect(lat, lon, tst, vel) {
      const motion = classifyMotion(lat, lon, tst, vel);

      // If at a known POI and the fix is stationary,
      // AND GPS still shows within the POI's exit radius,
      // GPS drift cannot cause a departure — reset any pending exit.
      if (lastLocation !== 'Roaming' && motion === 'stationary') {
        const currentPoi = locations.find(p => p.name === lastLocation);
        if (currentPoi && poiContains(currentPoi, lat, lon, exit_extra_m)) {
          pendingLocation = null;
          pendingCount = 0;
          pendingStartTime = null;
          stationaryCount = 0;
          return { changed: false, location: lastLocation, previousLocation: lastLocation };
        }
      }

      const current = resolveLocation(lat, lon);

      if (current === lastLocation) {
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        stationaryCount = 0;
        return { changed: false, location: lastLocation, previousLocation: lastLocation };
      }

      if (current === pendingLocation) {
        pendingCount++;
      } else {
        pendingLocation = current;
        pendingCount = 1;
        pendingStartTime = tst ?? null;
        stationaryCount = 0;
      }

      stationaryCount = motion === 'stationary' ? stationaryCount + 1
        : motion === 'moving' ? 0
        : stationaryCount;

      // Immediate arrival at a known location. The transition debounce
      // (min_transition_points / min_transition_seconds) exists to reject
      // drive-bys and GPS jitter near a POI edge. It has nothing to identify at
      // a place that is already in the database, so once the phone confirms it
      // is parked there, commit the arrival and skip the dwell entirely.
      // Mirrors the DRIVING departure fast path in server.js.
      //
      // Arrival is confirmed by `immediate_arrival_stationary_points`
      // consecutive stationary fixes rather than one, because a single
      // stationary fix is not proof of arrival: cars sit still at red lights,
      // and several learned POIs sit on roads. Requiring two costs one extra
      // ping (~30s, versus the 5-minute dwell) and rejects those. A moving fix
      // resets the run, so drive-bys still take the full debounce path.
      if (
        immediate_arrival_stationary_points > 0 &&
        current !== 'Roaming' &&
        stationaryCount >= immediate_arrival_stationary_points
      ) {
        const previousLocation = lastLocation;
        lastLocation = current;
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        stationaryCount = 0;
        return { changed: true, location: current, previousLocation, immediate: true };
      }

      const countMet = pendingCount >= min_transition_points;
      const timeMet = min_transition_seconds === 0
        || pendingStartTime == null
        || tst == null
        || (tst - pendingStartTime) >= min_transition_seconds;

      if (countMet && timeMet) {
        const previousLocation = lastLocation;
        lastLocation = current;
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        stationaryCount = 0;
        return { changed: true, location: current, previousLocation };
      }

      return { changed: false, location: lastLocation, previousLocation: lastLocation };
    },

    setLocation(name) {
      lastLocation = name;
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
      stationaryCount = 0;
    },

    getLocation() {
      return lastLocation;
    },

    resolveLocation(lat, lon) {
      return resolveLocation(lat, lon);
    },

    resetPending() {
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
      stationaryCount = 0;
    },

    forceResolve(lat, lon) {
      const current = resolveLocation(lat, lon);
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
      stationaryCount = 0;
      if (current === lastLocation) {
        return { changed: false, location: lastLocation, previousLocation: lastLocation };
      }
      const previousLocation = lastLocation;
      lastLocation = current;
      return { changed: true, location: current, previousLocation };
    },

    addLocation(poi) {
      locations.push(poi);
    },

    // Rename a known location in place. Returns true if a match was found.
    // Also updates the current location label so getLocation() reflects the
    // new name without waiting for the next transition.
    renameLocation(oldName, newName) {
      let found = false;
      for (const poi of locations) {
        if (poi.name === oldName) {
          poi.name = newName;
          if (poi.address !== undefined) poi.address = newName;
          found = true;
        }
      }
      if (lastLocation === oldName) lastLocation = newName;
      return found;
    },
  };
}

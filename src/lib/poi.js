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

export function createPOIDetector(config) {
  const { default_radius_m, locations, min_transition_points = 1, exit_extra_m = 0, min_transition_seconds = 0 } = config.poi;
  let lastLocation = 'Roaming';
  let pendingLocation = null;
  let pendingCount = 0;
  let pendingStartTime = null;

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
      // If at a known POI and phone confirms stationary (vel=0),
      // AND GPS still shows within the POI's exit radius,
      // GPS drift cannot cause a departure — reset any pending exit.
      if (lastLocation !== 'Roaming' && typeof vel === 'number' && vel === 0) {
        const currentPoi = locations.find(p => p.name === lastLocation);
        if (currentPoi && poiContains(currentPoi, lat, lon, exit_extra_m)) {
          pendingLocation = null;
          pendingCount = 0;
          pendingStartTime = null;
          return { changed: false, location: lastLocation, previousLocation: lastLocation };
        }
      }

      const current = resolveLocation(lat, lon);

      if (current === lastLocation) {
        pendingLocation = null;
        pendingCount = 0;
        pendingStartTime = null;
        return { changed: false, location: lastLocation, previousLocation: lastLocation };
      }

      if (current === pendingLocation) {
        pendingCount++;
      } else {
        pendingLocation = current;
        pendingCount = 1;
        pendingStartTime = tst ?? null;
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
        return { changed: true, location: current, previousLocation };
      }

      return { changed: false, location: lastLocation, previousLocation: lastLocation };
    },

    setLocation(name) {
      lastLocation = name;
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
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
    },

    forceResolve(lat, lon) {
      const current = resolveLocation(lat, lon);
      pendingLocation = null;
      pendingCount = 0;
      pendingStartTime = null;
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
  };
}

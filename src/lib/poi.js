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

export function createPOIDetector(config) {
  const { default_radius_m, locations, min_transition_points = 1, exit_extra_m = 0, min_transition_seconds = 0 } = config.poi;
  let lastLocation = 'Roaming';
  let pendingLocation = null;
  let pendingCount = 0;
  let pendingStartTime = null;

  function resolveLocation(lat, lon) {
    // Hysteresis: if currently at a POI, use larger exit radius for that POI
    if (lastLocation !== 'Roaming') {
      const currentPoi = locations.find(p => p.name === lastLocation);
      if (currentPoi) {
        const exitRadius = (currentPoi.radius_m ?? default_radius_m) + exit_extra_m;
        const dist = haversineDistance(lat, lon, currentPoi.lat, currentPoi.lon);
        if (dist <= exitRadius) return lastLocation;
      }
    }

    // Check entry into any POI using normal radius
    for (const poi of locations) {
      const radius = poi.radius_m ?? default_radius_m;
      const dist = haversineDistance(lat, lon, poi.lat, poi.lon);
      if (dist <= radius) return poi.name;
    }
    return 'Roaming';
  }

  return {
    detect(lat, lon, tst) {
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

    addLocation(poi) {
      locations.push(poi);
    },
  };
}

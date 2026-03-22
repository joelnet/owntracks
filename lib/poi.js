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
  const { default_radius_m, locations } = config.poi;
  let lastLocation = 'Roaming';

  return {
    detect(lat, lon) {
      let current = 'Roaming';
      for (const poi of locations) {
        const radius = poi.radius_m ?? default_radius_m;
        const dist = haversineDistance(lat, lon, poi.lat, poi.lon);
        if (dist <= radius) {
          current = poi.name;
          break;
        }
      }
      const changed = current !== lastLocation;
      const previousLocation = lastLocation;
      lastLocation = current;
      return { changed, location: current, previousLocation };
    },

    setLocation(name) {
      lastLocation = name;
    },
  };
}

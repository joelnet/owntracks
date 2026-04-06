import { haversineDistance } from './poi.js';

export async function reverseGeocode(lat, lon, { db, cacheRadiusM }) {
  // Check cache first
  const entries = db.prepare('SELECT lat, lon, address FROM geocode_cache').all();
  let nearest = null;
  let nearestDist = Infinity;
  for (const entry of entries) {
    const dist = haversineDistance(lat, lon, entry.lat, entry.lon);
    if (dist <= cacheRadiusM && dist < nearestDist) {
      nearest = entry;
      nearestDist = dist;
    }
  }
  if (nearest) return nearest.address;

  // Cache miss — call Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'owntracks-journal/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.display_name) return null;

    db.prepare('INSERT INTO geocode_cache (lat, lon, address, cached_at) VALUES (?, ?, ?, ?)')
      .run(lat, lon, data.display_name, new Date().toISOString());

    return data.display_name;
  } catch {
    return null;
  }
}

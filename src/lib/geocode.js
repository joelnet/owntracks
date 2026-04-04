import fs from 'node:fs';
import { haversineDistance } from './poi.js';

function readCache(cacheFile) {
  try {
    const content = fs.readFileSync(cacheFile, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendCache(cacheFile, entry) {
  fs.appendFileSync(cacheFile, JSON.stringify(entry) + '\n');
}

export async function reverseGeocode(lat, lon, { cacheFile, cacheRadiusM }) {
  // Check cache first
  const entries = readCache(cacheFile);
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

    appendCache(cacheFile, {
      lat,
      lon,
      address: data.display_name,
      cached_at: new Date().toISOString(),
    });

    return data.display_name;
  } catch {
    return null;
  }
}

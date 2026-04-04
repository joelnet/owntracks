import fs from 'node:fs';
import { haversineDistance } from './poi.js';

export async function reverseGeocode(lat, lon, { cacheFile, cacheRadiusM }) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'owntracks-journal/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.display_name) return null;
    return data.display_name;
  } catch {
    return null;
  }
}

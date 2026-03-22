import fs from 'node:fs';
import YAML from 'yaml';

export function loadConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read config file: ${filePath}`);
  }

  const config = YAML.parse(raw);

  if (!config || typeof config.poi !== 'object' || config.poi === null) {
    throw new Error('Config must contain a "poi" object');
  }

  const { poi } = config;

  if (typeof poi.default_radius_m !== 'number' || poi.default_radius_m <= 0) {
    throw new Error('poi.default_radius_m must be a positive number');
  }

  if (!Array.isArray(poi.locations) || poi.locations.length === 0) {
    throw new Error('poi.locations must be a non-empty array');
  }

  for (const loc of poi.locations) {
    if (typeof loc.name !== 'string') {
      throw new Error('Each location must have a name (string)');
    }
    if (typeof loc.lat !== 'number' || loc.lat < -90 || loc.lat > 90) {
      throw new Error(`Location "${loc.name}": lat must be a number between -90 and 90`);
    }
    if (typeof loc.lon !== 'number' || loc.lon < -180 || loc.lon > 180) {
      throw new Error(`Location "${loc.name}": lon must be a number between -180 and 180`);
    }
    if (loc.radius_m !== undefined && (typeof loc.radius_m !== 'number' || loc.radius_m <= 0)) {
      throw new Error(`Location "${loc.name}": radius_m must be a positive number`);
    }
  }

  return config;
}

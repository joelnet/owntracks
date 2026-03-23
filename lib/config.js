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

  if (config.max_accuracy_m !== undefined && (typeof config.max_accuracy_m !== 'number' || config.max_accuracy_m <= 0)) {
    throw new Error('max_accuracy_m must be a positive number');
  }

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

  if (config.activity !== undefined) {
    const { activity } = config;
    if (typeof activity.enabled !== 'boolean') throw new Error('activity.enabled must be a boolean');
    if (typeof activity.discord_notifications !== 'boolean') throw new Error('activity.discord_notifications must be a boolean');
    if (typeof activity.dwell_threshold_minutes !== 'number' || activity.dwell_threshold_minutes <= 0) throw new Error('activity.dwell_threshold_minutes must be a positive number');
    if (typeof activity.walking_max_kmh !== 'number' || activity.walking_max_kmh <= 0) throw new Error('activity.walking_max_kmh must be a positive number');
    if (typeof activity.driving_min_kmh !== 'number' || activity.driving_min_kmh <= 0) throw new Error('activity.driving_min_kmh must be a positive number');
    if (activity.walking_max_kmh >= activity.driving_min_kmh) throw new Error('activity.walking_max_kmh must be less than activity.driving_min_kmh');
    if (!Number.isInteger(activity.window_size) || activity.window_size < 3) throw new Error('activity.window_size must be an integer >= 3');
  }

  return config;
}

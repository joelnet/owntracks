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

  if (config.distance_unit !== undefined && config.distance_unit !== 'miles' && config.distance_unit !== 'kilometers') {
    throw new Error('distance_unit must be "miles" or "kilometers"');
  }

  if (!config || typeof config.poi !== 'object' || config.poi === null) {
    throw new Error('Config must contain a "poi" object');
  }

  const { poi } = config;

  if (typeof poi.default_radius_m !== 'number' || poi.default_radius_m <= 0) {
    throw new Error('poi.default_radius_m must be a positive number');
  }

  if (poi.min_transition_points !== undefined && (!Number.isInteger(poi.min_transition_points) || poi.min_transition_points < 1)) {
    throw new Error('poi.min_transition_points must be a positive integer');
  }

  if (poi.exit_extra_m !== undefined && (typeof poi.exit_extra_m !== 'number' || poi.exit_extra_m < 0)) {
    throw new Error('poi.exit_extra_m must be a non-negative number');
  }

  if (poi.min_transition_seconds !== undefined && (typeof poi.min_transition_seconds !== 'number' || poi.min_transition_seconds < 0)) {
    throw new Error('poi.min_transition_seconds must be a non-negative number');
  }

  if (poi.immediate_arrival_stationary_points !== undefined && (!Number.isInteger(poi.immediate_arrival_stationary_points) || poi.immediate_arrival_stationary_points < 0)) {
    throw new Error('poi.immediate_arrival_stationary_points must be a non-negative integer');
  }

  if (poi.stationary_displacement_m !== undefined && (typeof poi.stationary_displacement_m !== 'number' || poi.stationary_displacement_m < 0)) {
    throw new Error('poi.stationary_displacement_m must be a non-negative number');
  }

  if (!Array.isArray(poi.locations) || poi.locations.length === 0) {
    throw new Error('poi.locations must be a non-empty array');
  }

  for (const loc of poi.locations) {
    if (typeof loc.name !== 'string') {
      throw new Error('Each location must have a name (string)');
    }
    if (Array.isArray(loc.points)) {
      if (loc.points.length === 0) {
        throw new Error(`Location "${loc.name}": points must be a non-empty array`);
      }
      for (const p of loc.points) {
        if (typeof p.lat !== 'number' || p.lat < -90 || p.lat > 90) {
          throw new Error(`Location "${loc.name}": each point lat must be a number between -90 and 90`);
        }
        if (typeof p.lon !== 'number' || p.lon < -180 || p.lon > 180) {
          throw new Error(`Location "${loc.name}": each point lon must be a number between -180 and 180`);
        }
        if (p.radius_m !== undefined && (typeof p.radius_m !== 'number' || p.radius_m <= 0)) {
          throw new Error(`Location "${loc.name}": each point radius_m must be a positive number`);
        }
      }
    } else {
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
    if (activity.min_transition_seconds !== undefined && (typeof activity.min_transition_seconds !== 'number' || activity.min_transition_seconds < 0)) throw new Error('activity.min_transition_seconds must be a non-negative number');
    if (activity.stationary_max_spread_m !== undefined && (typeof activity.stationary_max_spread_m !== 'number' || activity.stationary_max_spread_m <= 0)) throw new Error('activity.stationary_max_spread_m must be a positive number');
  }

  if (config.discord !== undefined) {
    const { discord } = config;
    if (typeof discord.command_channel_id !== 'string') throw new Error('discord.command_channel_id must be a string');
  }

  if (config.visit_detection !== undefined) {
    const { visit_detection } = config;
    if (typeof visit_detection.enabled !== 'boolean') throw new Error('visit_detection.enabled must be a boolean');
    if (typeof visit_detection.containment_radius_m !== 'number' || visit_detection.containment_radius_m <= 0) throw new Error('visit_detection.containment_radius_m must be a positive number');
    if (typeof visit_detection.min_dwell_minutes !== 'number' || visit_detection.min_dwell_minutes <= 0) throw new Error('visit_detection.min_dwell_minutes must be a positive number');
    if (typeof visit_detection.exit_timeout_minutes !== 'number' || visit_detection.exit_timeout_minutes <= 0) throw new Error('visit_detection.exit_timeout_minutes must be a positive number');
    if (typeof visit_detection.discord_notifications !== 'boolean') throw new Error('visit_detection.discord_notifications must be a boolean');
    if (typeof visit_detection.learn_pois !== 'boolean') throw new Error('visit_detection.learn_pois must be a boolean');
    if (typeof visit_detection.learned_poi_radius_m !== 'number' || visit_detection.learned_poi_radius_m <= 0) throw new Error('visit_detection.learned_poi_radius_m must be a positive number');
    if (visit_detection.min_distance_from_known_poi_m !== undefined && (typeof visit_detection.min_distance_from_known_poi_m !== 'number' || visit_detection.min_distance_from_known_poi_m < 0)) throw new Error('visit_detection.min_distance_from_known_poi_m must be a non-negative number');
  }

  if (config.geocode !== undefined) {
    const { geocode } = config;
    if (typeof geocode.cache_radius_m !== 'number' || geocode.cache_radius_m <= 0) throw new Error('geocode.cache_radius_m must be a positive number');
  }

  return config;
}

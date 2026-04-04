import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { appendEntry } from "./lib/store.js";
import * as log from "./lib/logger.js";
import { loadConfig } from "./lib/config.js";
import { createPOIDetector } from "./lib/poi.js";
import { createDiscordClient } from "./lib/discord.js";
import { createActivityDetector } from "./lib/activity.js";
import { createVisitDetector } from "./lib/visit.js";
import { reverseGeocode as nominatimGeocode } from "./lib/geocode.js";

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp({ username, password, dataDir, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode } = {}) {
  const app = express();

  app.use(express.json());

  app.post("/pub", async (req, res) => {
    // Validate Basic Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      log.error("Missing or invalid Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);

    if (!safeEqual(user, username) || !safeEqual(pass, password)) {
      log.error(`Failed auth attempt for user: ${user}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate body
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      log.error("Invalid request body");
      return res.status(400).json({ error: "Bad request" });
    }

    // Build entry
    const { _type, ...fields } = req.body;
    const device = req.headers["x-limit-d"] || "phone";

    const entry = {
      username: user,
      device,
      ...fields,
      type: _type || "unknown",
      received_at: new Date().toISOString(),
    };

    // Skip low-accuracy GPS readings before any detection
    if (maxAccuracy && typeof entry.acc === 'number' && entry.acc > maxAccuracy) {
      if (detector) detector.resetPending();
      appendEntry(entry, dataDir);
      log.info(`Entry saved (skipped detection, acc=${entry.acc}): user=${user} device=${device} type=${entry.type}`);
      return res.status(200).json([]);
    }

    // POI detection
    if (
      detector &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const result = detector.detect(entry.lat, entry.lon, entry.tst);
      if (result.changed) {
        log.location(`Location: ${result.location}`);

        if (discord) {
          const message = result.location === 'Roaming'
            ? `Left ${result.previousLocation} (now Roaming)`
            : `Arrived at ${result.location}`;
          discord.notify(message);
        }
      }
    }

    // Activity detection
    if (
      activity &&
      entry.type === "location" &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const activityResult = activity.update(entry.lat, entry.lon, entry.tst, entry.vel);

      if (activityResult.changed || activityResult.initialClassification || activityResult.gapTransition) {
        if (onActivityPersist) {
          try {
            onActivityPersist(activity.getFullState());
          } catch (err) {
            log.error(`Failed to persist activity state: ${err.message}`);
          }
        }
      }

      if (activityResult.gapTransition && activityConfig?.discord_notifications && discord) {
        discord.notify('Now Stationary');
      }

      if (activityResult.changed && activityConfig?.discord_notifications && discord) {
        const stateName = activityResult.state.charAt(0) + activityResult.state.slice(1).toLowerCase();
        discord.notify(`Now ${stateName}`);
      }
    }

    // Visit detection
    if (
      visit &&
      entry.type === "location" &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const poiResult = detector ? detector.resolveLocation(entry.lat, entry.lon) : 'Roaming';
      const activityState = activity ? activity.getState() : 'UNKNOWN';
      const visitResult = visit.processPoint(
        { lat: entry.lat, lon: entry.lon, tst: entry.tst },
        poiResult,
        activityState
      );

      // Geocode and rename learned POI before persisting
      let geocodedAddress = null;
      if (visitResult?.type === 'visit_started' && reverseGeocode) {
        geocodedAddress = await reverseGeocode(visitResult.centroid.lat, visitResult.centroid.lon);
        if (geocodedAddress && visitConfig?.learn_pois) {
          visit.renameLearnedPoi(visitResult.centroid.lat, visitResult.centroid.lon, geocodedAddress);
        }
      }

      // Sync newly learned POI to the POI detector so it's recognized immediately
      if (visitResult?.type === 'visit_started' && visitConfig?.learn_pois && detector) {
        const currentPois = visit.getLearnedPois();
        const newPoi = currentPois.find(p =>
          Math.abs(p.lat - visitResult.centroid.lat) < 0.001 &&
          Math.abs(p.lon - visitResult.centroid.lon) < 0.001
        );
        if (newPoi) {
          detector.addLocation(newPoi);
        }
      }

      if (onVisitPersist) {
        try {
          onVisitPersist(visit.getState(), visit.getLearnedPois());
        } catch (err) {
          log.error(`Failed to persist visit state: ${err.message}`);
        }
      }

      if (visitResult && visitConfig?.discord_notifications && discord) {
        if (visitResult.type === 'visit_started') {
          if (geocodedAddress) {
            discord.notify(`POI Lookup at ${geocodedAddress}`);
          } else {
            discord.notify(`POI Lookup failed for (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)})`);
          }
        }
        if (visitResult.type === 'visit_ended') {
          discord.notify(`Left unknown location (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)}) — ${visitResult.duration_minutes} min visit`);
        }
      }
    }

    appendEntry(entry, dataDir);
    log.info(`Entry saved: user=${user} device=${device} type=${entry.type}`);

    return res.status(200).json([]);
  });

  return app;
}

// Start server when run directly (not imported by tests)
const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    log.error(`Unhandled rejection: ${err?.message || err}`);
  });
  const port = process.env.PORT || 3000;
  const username = process.env.OWNTRACKS_USERNAME;
  const password = process.env.OWNTRACKS_PASSWORD;

  if (!username || !password) {
    log.error("OWNTRACKS_USERNAME and OWNTRACKS_PASSWORD must be set in .env");
    process.exit(1);
  }

  // Load config and create POI detector
  const config = loadConfig(path.join(import.meta.dirname, "..", "config.yml"));

  // Load learned POIs and merge into POI config before creating detector
  let learnedPois = [];
  const learnedPoisPath = path.join(import.meta.dirname, '..', 'data', 'learned-pois.json');
  if (config.visit_detection?.enabled && config.visit_detection?.learn_pois) {
    try {
      learnedPois = JSON.parse(fs.readFileSync(learnedPoisPath, 'utf-8'));
      for (const poi of learnedPois) {
        config.poi.locations.push(poi);
      }
      log.info(`Loaded ${learnedPois.length} learned POIs`);
    } catch {
      log.info('No learned POIs to load');
    }
  }

  const detector = createPOIDetector(config);

  // Seed detector state from location log, then verify against latest GPS data
  let lastLocation = "Roaming";
  try {
    const logContent = fs.readFileSync(log.LOCATION_LOG_PATH, "utf-8");
    const lines = logContent.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/Location: (.+)$/);
      if (match) {
        lastLocation = match[1];
        break;
      }
    }
  } catch {
    // No location log yet — default to Roaming
  }

  // Re-check last GPS coordinates against current POI config
  // This handles new POIs added since last transition, or config changes
  let seededFromGps = false;
  try {
    const dataDir = path.join(import.meta.dirname, "..", "data");
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".jsonl")).sort();
    if (files.length > 0) {
      const lastFile = fs.readFileSync(path.join(dataDir, files[files.length - 1]), "utf-8");
      const lines = lastFile.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]);
        if (typeof entry.lat === "number" && typeof entry.lon === "number") {
          lastLocation = detector.resolveLocation(entry.lat, entry.lon);
          detector.setLocation(lastLocation);
          seededFromGps = true;
          break;
        }
      }
    }
  } catch {
    // Fall back to location log value
  }
  if (!seededFromGps) {
    detector.setLocation(lastLocation);
  }

  log.location(`Last known location: ${lastLocation}`);

  // Initialize Discord bot (optional)
  let discord;
  const discordToken = process.env.DISCORD_TOKEN;
  const discordChannelId = process.env.DISCORD_CHANNEL_ID;
  const discordGuildId = process.env.DISCORD_GUILD_ID;

  if (discordToken && discordChannelId && discordGuildId) {
    const dataDir = path.join(import.meta.dirname, '..', 'data');
    discord = createDiscordClient({ token: discordToken, channelId: discordChannelId, guildId: discordGuildId, detector, config, dataDir });
    discord.start().catch(err => log.error(`Discord failed to connect: ${err.message}`));
  }

  // Initialize activity detector (optional)
  let activity;
  let activityConfig;
  let onActivityPersist;
  if (config.activity?.enabled) {
    activityConfig = config.activity;
    activity = createActivityDetector(activityConfig);

    // Restore persisted state
    const activityStatePath = path.join(import.meta.dirname, "..", "data", "activity-state.json");
    try {
      const saved = JSON.parse(fs.readFileSync(activityStatePath, "utf-8"));
      activity.setState(saved);
      log.info(`Activity state restored: ${saved.currentState}`);
    } catch {
      log.info("No activity state to restore — starting fresh");
    }

    onActivityPersist = (state) => {
      const dir = path.join(import.meta.dirname, "..", "data");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "activity-state.json"), JSON.stringify(state), "utf-8");
    };
  }

  // Initialize visit detector (optional)
  let visit;
  let visitConfig;
  let onVisitPersist;
  if (config.visit_detection?.enabled) {
    visitConfig = config.visit_detection;

    const visitStatePath = path.join(import.meta.dirname, '..', 'data', 'visit-session.json');
    let savedVisitState = null;
    try {
      savedVisitState = JSON.parse(fs.readFileSync(visitStatePath, 'utf-8'));
      log.info(`Visit session restored: active=${savedVisitState.active}`);
    } catch {
      log.info('No visit session to restore');
    }

    visit = createVisitDetector(visitConfig, savedVisitState);
    visit.loadLearnedPois(learnedPois);

    onVisitPersist = (state, pois) => {
      const dir = path.join(import.meta.dirname, '..', 'data');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'visit-session.json'), JSON.stringify(state), 'utf-8');
      fs.writeFileSync(path.join(dir, 'learned-pois.json'), JSON.stringify(pois, null, 2), 'utf-8');
    };
  }

  // Build geocode function if configured
  let reverseGeocode;
  if (config.geocode) {
    const geocodeCacheFile = path.join(import.meta.dirname, '..', 'data', 'geocode-cache.jsonl');
    const geocodeCacheRadiusM = config.geocode.cache_radius_m;
    reverseGeocode = (lat, lon) => nominatimGeocode(lat, lon, { cacheFile: geocodeCacheFile, cacheRadiusM: geocodeCacheRadiusM });
  }

  const maxAccuracy = config.max_accuracy_m;
  const app = createApp({ username, password, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode });
  const server = app.listen(port, () => {
    log.info(`Server started on port ${port}`);
  });

  process.once("SIGUSR2", () => {
    log.info("Server shutting down (nodemon restart)");
    if (discord) discord.destroy();
    server.close(() => process.kill(process.pid, "SIGUSR2"));
  });
}

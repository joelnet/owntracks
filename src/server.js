import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { createStore } from "./lib/store.js";
import * as log from "./lib/logger.js";
import { loadConfig } from "./lib/config.js";
import { createPOIDetector } from "./lib/poi.js";
import { createDiscordClient } from "./lib/discord.js";
import { createActivityDetector } from "./lib/activity.js";
import { createVisitDetector } from "./lib/visit.js";
import { reverseGeocode as nominatimGeocode } from "./lib/geocode.js";
import { openDatabase, initSchema } from "./lib/db.js";

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp({ username, password, store, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode } = {}) {
  const app = express();
  let lastProcessedTst = null;

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

    // Skip low-accuracy GPS readings before any detection. Clear any
    // half-accumulated POI transition so a noisy point can't count toward a
    // false arrival/departure once we later see a clean fix.
    if (maxAccuracy && typeof entry.acc === 'number' && entry.acc > maxAccuracy) {
      if (detector && typeof detector.resetPending === 'function') {
        detector.resetPending();
      }
      store.appendEntry(entry);
      log.info(`Entry saved (skipped detection, acc=${entry.acc}): user=${user} device=${device} type=${entry.type}`);
      return res.status(200).json([]);
    }

    // When the phone can't get a fresh GPS fix (e.g. indoors), OwnTracks
    // re-sends the last known position with the same tst. Substitute server
    // time so detectors see time progressing while the user is stationary.
    let effectiveTst = entry.tst;
    if (typeof entry.tst === 'number' && entry.tst === lastProcessedTst) {
      effectiveTst = Math.floor(Date.now() / 1000);
    } else if (typeof entry.tst === 'number') {
      lastProcessedTst = entry.tst;
    }

    // POI detection
    if (
      detector &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const result = detector.detect(entry.lat, entry.lon, effectiveTst, entry.vel);
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
      const activityResult = activity.update(entry.lat, entry.lon, effectiveTst, entry.vel);

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

      // DRIVING is a strong departure signal — bypass POI dwell so "Left X"
      // fires immediately instead of waiting for min_transition_seconds.
      if (
        (activityResult.changed || activityResult.initialClassification) &&
        activityResult.state === 'DRIVING' &&
        detector
      ) {
        const forceResult = detector.forceResolve(entry.lat, entry.lon);
        if (forceResult.changed) {
          log.location(`Location: ${forceResult.location}`);
          if (discord) {
            const message = forceResult.location === 'Roaming'
              ? `Left ${forceResult.previousLocation} (now Roaming)`
              : `Arrived at ${forceResult.location}`;
            discord.notify(message);
          }
        }
      }
    }

    // Visit detection
    if (
      visit &&
      entry.type === "location" &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const poiResult = detector ? detector.getLocation() : 'Roaming';
      const activityState = activity ? activity.getState() : 'UNKNOWN';
      const visitResult = visit.processPoint(
        { lat: entry.lat, lon: entry.lon, tst: effectiveTst },
        poiResult,
        activityState
      );

      // Geocode and rename learned POI before persisting
      let geocodedAddress = null;
      if ((visitResult?.type === 'visit_started' || visitResult?.type === 'visit_ended') && reverseGeocode) {
        geocodedAddress = await reverseGeocode(visitResult.centroid.lat, visitResult.centroid.lon);
        if (geocodedAddress && visitResult.type === 'visit_started' && visitConfig?.learn_pois) {
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
          if (geocodedAddress) {
            discord.notify(`Left ${geocodedAddress} — ${visitResult.duration_minutes} min visit`);
          } else {
            discord.notify(`Left unknown location (${visitResult.centroid.lat.toFixed(4)}, ${visitResult.centroid.lon.toFixed(4)}) — ${visitResult.duration_minutes} min visit`);
          }
        }
      }
    }

    store.appendEntry(entry);
    log.info(`Entry saved: user=${user} device=${device} type=${entry.type}`);

    return res.status(200).json([]);
  });

  return app;
}

// Start server when run directly (not imported by tests)
const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const port = process.env.PORT || 3000;
  const username = process.env.OWNTRACKS_USERNAME;
  const password = process.env.OWNTRACKS_PASSWORD;

  if (!username || !password) {
    log.error("OWNTRACKS_USERNAME and OWNTRACKS_PASSWORD must be set in .env");
    process.exit(1);
  }

  // Open database
  const db = openDatabase();
  initSchema(db);
  const store = createStore(db);

  // Load config and create POI detector
  const config = loadConfig(path.join(import.meta.dirname, "..", "config.yml"));

  // Load learned POIs from database and merge into POI config
  let learnedPois = [];
  if (config.visit_detection?.enabled && config.visit_detection?.learn_pois) {
    learnedPois = db.prepare('SELECT * FROM learned_pois').all();
    for (const poi of learnedPois) {
      config.poi.locations.push(poi);
    }
    log.info(`Loaded ${learnedPois.length} learned POIs`);
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
  let seededFromGps = false;
  const lastEntry = db.prepare(
    'SELECT data FROM location_entries WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY tst DESC LIMIT 1'
  ).get();
  if (lastEntry) {
    const entry = JSON.parse(lastEntry.data);
    lastLocation = detector.resolveLocation(entry.lat, entry.lon);
    detector.setLocation(lastLocation);
    seededFromGps = true;
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
    discord = createDiscordClient({ token: discordToken, channelId: discordChannelId, guildId: discordGuildId, detector, config, db });
    discord.start().catch(err => log.error(`Discord failed to connect: ${err.message}`));
  }

  // Initialize activity detector (optional)
  let activity;
  let activityConfig;
  let onActivityPersist;
  const saveState = db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');

  if (config.activity?.enabled) {
    activityConfig = config.activity;
    activity = createActivityDetector(activityConfig);

    // Restore persisted state
    const savedRow = db.prepare('SELECT value FROM app_state WHERE key = ?').get('activity_state');
    if (savedRow) {
      const saved = JSON.parse(savedRow.value);
      activity.setState(saved);
      log.info(`Activity state restored: ${saved.currentState}`);
    } else {
      log.info("No activity state to restore — starting fresh");
    }

    onActivityPersist = (state) => {
      saveState.run('activity_state', JSON.stringify(state), new Date().toISOString());
    };
  }

  // Initialize visit detector (optional)
  let visit;
  let visitConfig;
  let onVisitPersist;
  if (config.visit_detection?.enabled) {
    visitConfig = config.visit_detection;

    const savedRow = db.prepare('SELECT value FROM app_state WHERE key = ?').get('visit_session');
    let savedVisitState = null;
    if (savedRow) {
      savedVisitState = JSON.parse(savedRow.value);
      log.info(`Visit session restored: active=${savedVisitState.active}`);
    } else {
      log.info('No visit session to restore');
    }

    visit = createVisitDetector(visitConfig, savedVisitState);
    visit.loadLearnedPois(learnedPois);

    const upsertPoi = db.prepare(`
      INSERT OR REPLACE INTO learned_pois (id, name, address, lat, lon, radius_m, discovered_at, visit_count, last_visited_at)
      VALUES (@id, @name, @address, @lat, @lon, @radius_m, @discovered_at, @visit_count, @last_visited_at)
    `);
    const deletePois = db.prepare('DELETE FROM learned_pois');
    const insertPoi = db.prepare(`
      INSERT INTO learned_pois (name, address, lat, lon, radius_m, discovered_at, visit_count, last_visited_at)
      VALUES (@name, @address, @lat, @lon, @radius_m, @discovered_at, @visit_count, @last_visited_at)
    `);
    const syncPois = db.transaction((pois) => {
      deletePois.run();
      for (const poi of pois) {
        insertPoi.run(poi);
      }
    });

    onVisitPersist = (state, pois) => {
      saveState.run('visit_session', JSON.stringify(state), new Date().toISOString());
      syncPois(pois);
    };
  }

  // Build geocode function if configured
  let reverseGeocode;
  if (config.geocode) {
    const geocodeCacheRadiusM = config.geocode.cache_radius_m;
    reverseGeocode = (lat, lon) => nominatimGeocode(lat, lon, { db, cacheRadiusM: geocodeCacheRadiusM });
  }

  const maxAccuracy = config.max_accuracy_m;
  const app = createApp({ username, password, store, detector, discord, activity, activityConfig, onActivityPersist, visit, visitConfig, onVisitPersist, maxAccuracy, reverseGeocode });
  const server = app.listen(port, () => {
    log.info(`Server started on port ${port}`);
  });

  let shuttingDown = false;

  async function shutdown({ reason, exitCode = 0, nodemonRestart = false }) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`Server shutting down (${reason})`);

    const forceCloseTimer = setTimeout(() => {
      log.error("Graceful shutdown timed out; forcing remaining connections closed");
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    }, 10000);
    forceCloseTimer.unref();

    try {
      if (discord) {
        await discord.destroy();
      }

      await new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            log.error(`HTTP server close failed: ${err.message}`);
          }
          resolve();
        });
      });

      db.close();
      clearTimeout(forceCloseTimer);
      log.info("Server shutdown complete");
    } catch (err) {
      clearTimeout(forceCloseTimer);
      log.error(`Shutdown failed: ${err?.stack || err?.message || err}`);
      exitCode = exitCode || 1;
    }

    if (nodemonRestart) {
      process.kill(process.pid, "SIGUSR2");
      return;
    }

    process.exit(exitCode);
  }

  process.once("SIGTERM", () => {
    shutdown({ reason: "SIGTERM" });
  });

  process.once("SIGINT", () => {
    shutdown({ reason: "SIGINT" });
  });

  process.once("SIGUSR2", () => {
    shutdown({ reason: "nodemon restart", nodemonRestart: true });
  });

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err?.stack || err?.message || err}`);
    shutdown({ reason: "uncaught exception", exitCode: 1 });
  });

  process.on("unhandledRejection", (err) => {
    log.error(`Unhandled rejection: ${err?.stack || err?.message || err}`);
    shutdown({ reason: "unhandled rejection", exitCode: 1 });
  });
}

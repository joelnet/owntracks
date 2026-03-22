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

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp({ username, password, dataDir, detector, discord } = {}) {
  const app = express();

  app.use(express.json());

  app.post("/pub", (req, res) => {
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

    // POI detection
    if (
      detector &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const result = detector.detect(entry.lat, entry.lon);
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
  const port = process.env.PORT || 3000;
  const username = process.env.OWNTRACKS_USERNAME;
  const password = process.env.OWNTRACKS_PASSWORD;

  if (!username || !password) {
    log.error("OWNTRACKS_USERNAME and OWNTRACKS_PASSWORD must be set in .env");
    process.exit(1);
  }

  // Load config and create POI detector
  const config = loadConfig(path.join(import.meta.dirname, "config.yml"));
  const detector = createPOIDetector(config);

  // Seed detector state from location log
  let lastLocation = "Roaming";
  try {
    const logContent = fs.readFileSync(log.LOCATION_LOG_PATH, "utf-8");
    const lines = logContent.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(/Location: (.+)$/);
      if (match) {
        lastLocation = match[1];
        detector.setLocation(lastLocation);
        break;
      }
    }
  } catch {
    // No location log yet — default to Roaming
  }
  log.location(`Last known location: ${lastLocation}`);

  // Initialize Discord bot (optional)
  let discord;
  const discordToken = process.env.DISCORD_TOKEN;
  const discordChannelId = process.env.DISCORD_CHANNEL_ID;
  const discordGuildId = process.env.DISCORD_GUILD_ID;

  if (discordToken && discordChannelId && discordGuildId) {
    discord = createDiscordClient({ token: discordToken, channelId: discordChannelId, guildId: discordGuildId, detector });
    discord.start().catch(err => log.error(`Discord failed to connect: ${err.message}`));
  }

  const app = createApp({ username, password, detector, discord });
  const server = app.listen(port, () => {
    log.info(`Server started on port ${port}`);
  });

  process.once("SIGUSR2", () => {
    log.info("Server shutting down (nodemon restart)");
    if (discord) discord.destroy();
    server.close(() => process.kill(process.pid, "SIGUSR2"));
  });
}

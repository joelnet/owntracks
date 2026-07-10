import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { generateReport } from './report.js';

// The /location slash command's response when the user isn't at a known POI.
// Replying to this message saves a brand-new POI at the current position
// (see createLearnedLocationHere) rather than renaming an existing one.
export const ROAMING_LOCATION_MESSAGE = 'Currently Roaming';

// Notification formats that carry a location name the user can correct by
// replying. The captured group is the location name as it was announced.
// "Currently at X" is the /location command's response when already at a POI,
// so replying to it renames that POI just like replying to a live arrival.
const LOCATION_MESSAGE_PATTERNS = [
  /^Arrived at (.+)$/s,
  /^POI Lookup at (.+)$/s,
  /^Left (.+) — \d+ min visit$/s,
  /^Left (.+) \(now Roaming\)$/s,
  /^Currently at (.+)$/s,
];

// Extract the announced location name from one of our own notifications, or
// null if the message isn't a location notification we can act on.
export function parseLocationName(content) {
  if (typeof content !== 'string') return null;
  for (const pattern of LOCATION_MESSAGE_PATTERNS) {
    const match = content.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

// True when the message is the /location "Roaming" response — replying to it
// creates a new POI at the current position instead of renaming one.
export function isRoamingLocationMessage(content) {
  return content === ROAMING_LOCATION_MESSAGE;
}

export function createDiscordClient({ token, channelId, guildId, detector, config, db, visit }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // GuildMessages + MessageContent let the bot read replies to its own
      // notifications so a location name can be corrected inline. MessageContent
      // is a privileged intent — enable it in the Discord Developer Portal.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  let ready = false;

  // Rename a learned POI in the DB and both in-memory detectors. Configured
  // POIs (Home, Work, …) aren't in learned_pois and are intentionally left
  // alone. Returns { ok, reason }.
  function renameLearnedLocation(oldName, newName) {
    if (!db) return { ok: false, reason: 'unavailable' };
    const row = db.prepare('SELECT * FROM learned_pois WHERE name = ?').get(oldName);
    if (!row) return { ok: false, reason: 'not_found' };

    db.prepare('UPDATE learned_pois SET name = ?, address = ? WHERE id = ?')
      .run(newName, newName, row.id);
    // Keep in-memory state consistent so the next persist (delete-all +
    // reinsert from the visit detector) doesn't clobber the new name, and so
    // arrivals announce the corrected name immediately.
    if (visit?.renameLearnedPoi) visit.renameLearnedPoi(row.lat, row.lon, newName);
    if (detector?.renameLocation) detector.renameLocation(oldName, newName);
    return { ok: true };
  }

  // Latest known GPS position, used to anchor an on-demand POI. Mirrors the
  // seed query in server.js (newest by tst).
  function currentPosition() {
    if (!db) return null;
    const row = db.prepare(
      'SELECT lat, lon FROM location_entries WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY tst DESC LIMIT 1'
    ).get();
    return row ? { lat: row.lat, lon: row.lon } : null;
  }

  // Create a learned POI at the current position. Lets the user save a place
  // while Roaming — before the auto POI-lookup fires, or when the visit guard
  // suppresses it. Returns { ok, reason?, lat?, lon? }.
  function createLearnedLocationHere(name) {
    if (!db) return { ok: false, reason: 'unavailable' };
    const pos = currentPosition();
    if (!pos) return { ok: false, reason: 'no_location' };

    const radius_m = config?.visit_detection?.learned_poi_radius_m
      ?? config?.poi?.default_radius_m ?? 100;
    const now = new Date().toISOString();
    const poi = {
      name,
      address: name,
      lat: pos.lat,
      lon: pos.lon,
      radius_m,
      discovered_at: now,
      visit_count: 1,
      last_visited_at: now,
    };

    db.prepare(`
      INSERT INTO learned_pois (name, address, lat, lon, radius_m, discovered_at, visit_count, last_visited_at)
      VALUES (@name, @address, @lat, @lon, @radius_m, @discovered_at, @visit_count, @last_visited_at)
    `).run(poi);

    // Mirror into the live detectors: the visit detector so the next persist
    // (delete-all + reinsert from its in-memory list) keeps the row, and the
    // POI detector so /location recognizes the spot immediately.
    if (visit?.addLearnedPoi) visit.addLearnedPoi(poi);
    if (detector?.addLocation) detector.addLocation({ ...poi });

    return { ok: true, lat: pos.lat, lon: pos.lon };
  }

  client.once('clientReady', async () => {
    try {
      const locationCmd = new SlashCommandBuilder()
        .setName('location')
        .setDescription('Show current location');

      const reportCmd = new SlashCommandBuilder()
        .setName('location-report')
        .setDescription('Show daily location & activity report')
        .addStringOption(option =>
          option.setName('date')
            .setDescription('Date in YYYY-MM-DD format (defaults to today)')
            .setRequired(false)
        );

      const rest = new REST().setToken(token);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: [locationCmd.toJSON(), reportCmd.toJSON()] }
      );

      ready = true;
      console.log(`Discord bot ready as ${client.user.tag}`);
    } catch (err) {
      console.error('Discord setup error:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('Discord client error:', err.message);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (config?.discord?.command_channel_id && interaction.channelId !== config.discord.command_channel_id) return;

    if (interaction.commandName === 'location') {
      try {
        if (!detector) {
          await interaction.reply({ content: 'No location data available', ephemeral: true });
          return;
        }

        const location = detector.getLocation();
        const content = location === 'Roaming'
          ? ROAMING_LOCATION_MESSAGE
          : `Currently at ${location}`;
        // Non-ephemeral so the user can reply to it: replying to "Roaming"
        // saves a new POI here, replying to "at X" renames that POI.
        await interaction.reply({ content });
      } catch (err) {
        console.error('Discord interaction error:', err.message);
      }
      return;
    }

    if (interaction.commandName === 'location-report') {
      try {
        const tz = process.env.TZ || 'America/Los_Angeles';
        const date = interaction.options.getString('date')
          || new Date().toLocaleDateString('en-CA', { timeZone: tz });

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
          return;
        }

        if (!config || !db) {
          await interaction.reply({ content: 'Report not available (server misconfigured).', ephemeral: true });
          return;
        }

        await interaction.deferReply();

        // Merge learned POIs from DB (same as npm run report)
        const reportConfig = { ...config, poi: { ...config.poi, locations: [...config.poi.locations] } };
        const learnedPois = db.prepare('SELECT * FROM learned_pois').all();
        for (const poi of learnedPois) {
          if (!reportConfig.poi.locations.some(l => l.lat === poi.lat && l.lon === poi.lon)) {
            reportConfig.poi.locations.push(poi);
          }
        }

        const report = await generateReport(date, reportConfig, db, tz);

        if (!report) {
          await interaction.editReply(`No location data found for ${date}`);
          return;
        }

        const content = '```\n' + report + '\n```';

        if (content.length <= 2000) {
          await interaction.editReply(content);
        } else {
          // Split into chunks if the report is too long for one message
          const chunks = splitMessage(report, 1990);
          await interaction.editReply('```\n' + chunks[0] + '\n```');
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp('```\n' + chunks[i] + '\n```');
          }
        }
      } catch (err) {
        console.error('Discord report error:', err.message);
        try {
          if (interaction.deferred) {
            await interaction.editReply('Failed to generate report.');
          } else {
            await interaction.reply({ content: 'Failed to generate report.', ephemeral: true });
          }
        } catch { /* ignore follow-up errors */ }
      }
      return;
    }
  });

  // Reply-to-correct: when the user replies to one of our location
  // notifications, treat the reply text as the corrected name for that place.
  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.reference?.messageId) return;
      // Only act in the channel we post notifications to.
      if (message.channelId !== channelId) return;

      let referenced;
      try {
        referenced = await message.channel.messages.fetch(message.reference.messageId);
      } catch {
        return;
      }
      if (!referenced || referenced.author.id !== client.user.id) return;

      const newName = message.content.trim();
      if (!newName) return;

      // Replying to "Currently Roaming" saves a brand-new POI at the current
      // position — for when the auto POI-lookup hasn't fired yet or the visit
      // guard suppressed it.
      if (isRoamingLocationMessage(referenced.content)) {
        const result = createLearnedLocationHere(newName);
        if (result.ok) {
          await message.reply(`✅ Saved **${newName}** as a POI here (${result.lat.toFixed(5)}, ${result.lon.toFixed(5)})`);
        } else if (result.reason === 'no_location') {
          await message.reply(`⚠️ No recent GPS fix to anchor a POI here.`);
        } else {
          await message.reply(`⚠️ Saving a POI is unavailable right now.`);
        }
        return;
      }

      const oldName = parseLocationName(referenced.content);
      if (!oldName) return;

      const result = renameLearnedLocation(oldName, newName);
      if (result.ok) {
        await message.reply(`✅ Renamed to **${newName}**`);
      } else if (result.reason === 'not_found') {
        await message.reply(`⚠️ Couldn't find a learned location matching that message — it may be a fixed POI from config.`);
      } else {
        await message.reply(`⚠️ Rename is unavailable right now.`);
      }
    } catch (err) {
      console.error('Discord rename error:', err.message);
    }
  });

  return {
    start() {
      return client.login(token);
    },
    notify(message) {
      if (!ready) return;
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        channel.send(message).catch(err => console.error('Discord notify error:', err));
      }
    },
    getReady() {
      return ready;
    },
    destroy() {
      return client.destroy();
    },
  };
}

function splitMessage(text, maxLen) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

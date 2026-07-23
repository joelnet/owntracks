import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { generateReport } from './report.js';
import {
  parseTenants,
  orderTenants,
  defaultDisplayName,
  nearAnchor,
  getVisitLabel,
  setVisitLabel,
} from './tenants.js';

// The /location slash command's response when the user isn't at a known POI.
// Replying to this message saves a brand-new POI at the current position
// (see createLearnedLocationHere) rather than correcting an existing one.
export const ROAMING_LOCATION_MESSAGE = 'Currently Roaming';

// Reaction shortcuts on multi-tenant arrival prompts, in option order.
export const TENANT_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

// Explicit rename escape hatch: a reply of "rename: X" always renames the
// anchor POI instead of recording a tenant pick.
const RENAME_PREFIX = /^rename:\s*(.+)$/is;

const TENANT_PROMPTS_KEY = 'tenant_prompts';
const TENANT_PROMPT_TTL_S = 3 * 24 * 60 * 60;

// Notification formats that carry a location name the user can correct by
// replying. The captured group is the location name as it was announced.
// The `kind` decides what a plain reply means: the visit-flow messages
// (poi_lookup, visit_left) announce a freshly geocoded POI, so a reply
// christens (renames) it; the POI-flow messages announce an established
// place, so a reply records which business was actually visited today.
const LOCATION_MESSAGE_PATTERNS = [
  { kind: 'arrival', pattern: /^Arrived at (.+)$/s },
  { kind: 'poi_lookup', pattern: /^POI Lookup at (.+)$/s },
  { kind: 'visit_left', pattern: /^Left (.+) — \d+ min visit$/s },
  { kind: 'poi_left', pattern: /^Left (.+) \(now Roaming\)$/s },
  { kind: 'current', pattern: /^Currently at (.+)$/s },
];

// Extract the announced location name and message kind from one of our own
// notifications, or null if the message isn't one we can act on.
export function parseLocationMessage(content) {
  if (typeof content !== 'string') return null;
  for (const { kind, pattern } of LOCATION_MESSAGE_PATTERNS) {
    const match = content.match(pattern);
    if (match) return { kind, name: match[1].trim() };
  }
  return null;
}

export function parseLocationName(content) {
  return parseLocationMessage(content)?.name ?? null;
}

// True when the message is the /location "Roaming" response — replying to it
// creates a new POI at the current position instead of correcting one.
export function isRoamingLocationMessage(content) {
  return content === ROAMING_LOCATION_MESSAGE;
}

// "A or B" / "A, B, or C" for the arrival prompt's first line.
function joinOr(names) {
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

export function createDiscordClient({ token, channelId, guildId, detector, config, db, visit, journal }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // GuildMessages + MessageContent let the bot read replies to its own
      // notifications so a location name can be corrected inline. MessageContent
      // is a privileged intent — enable it in the Discord Developer Portal.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Reactions drive tenant selection on multi-business arrival prompts.
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Reactions on messages sent before a restart arrive as partials.
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
  let ready = false;
  const tz = config?.journal?.timezone || process.env.TZ || 'America/Los_Angeles';

  // Local-day bucket key for visit labels, matching the journal's file naming.
  function localDate(tst) {
    return new Date(tst * 1000).toLocaleDateString('en-CA', { timeZone: tz });
  }

  function nowTst() {
    return Math.floor(Date.now() / 1000);
  }

  // Pending tenant prompts: Discord message id → { lat, lon, tst, tenants }.
  // Persisted in app_state so a reaction still resolves after a restart.
  let tenantPrompts = {};
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(TENANT_PROMPTS_KEY);
      if (row) tenantPrompts = JSON.parse(row.value);
    } catch {
      tenantPrompts = {};
    }
  }

  function saveTenantPrompts() {
    if (!db) return;
    const cutoff = nowTst() - TENANT_PROMPT_TTL_S;
    for (const [id, ctx] of Object.entries(tenantPrompts)) {
      if (!ctx || typeof ctx.tst !== 'number' || ctx.tst < cutoff) delete tenantPrompts[id];
    }
    db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(TENANT_PROMPTS_KEY, JSON.stringify(tenantPrompts), new Date().toISOString());
  }

  // A learned POI by its anchor name or any of its tenant names. Tables stay
  // tiny (dozens of rows), so a scan is fine.
  function findLearnedPoi(name) {
    if (!db) return null;
    const rows = db.prepare('SELECT * FROM learned_pois').all();
    return rows.find(r => r.name === name)
      ?? rows.find(r => (parseTenants(r.tenants) ?? []).some(t => t.name === name))
      ?? null;
  }

  function findLearnedPoiNear(lat, lon) {
    if (!db) return null;
    return db.prepare('SELECT * FROM learned_pois').all()
      .find(r => nearAnchor(r.lat, r.lon, lat, lon)) ?? null;
  }

  // Labels and renames change how the journal names the affected day's stays —
  // rewrite that note right away instead of waiting for the next GPS ping.
  function refreshJournal(date) {
    journal?.writeDay?.(date)?.catch?.(err => console.error('Journal rewrite error:', err.message));
  }

  // The user-facing name for an anchor right now: today's picked label, else
  // the most-picked tenant, else the anchor name itself.
  function displayNameFor(anchorName) {
    if (!db) return anchorName;
    const row = findLearnedPoi(anchorName);
    if (!row) return anchorName;
    return getVisitLabel(db, row.lat, row.lon, localDate(nowTst())) ?? defaultDisplayName(row);
  }

  // Record that the visit on `tst`'s local day at `row`'s anchor was to
  // `name`: ensure it's in the tenant list, bump its pick count, and write the
  // per-day visit label the journal substitutes at render time. The anchor's
  // own name — what detection announces — never changes here.
  function recordTenantSelection(row, name, tst) {
    const tenants = parseTenants(row.tenants)
      ?? [{ name: row.name, visit_count: row.visit_count ?? 1, last_selected_at: null }];
    let entry = tenants.find(t => t.name === name);
    if (!entry) {
      entry = { name, visit_count: 0, last_selected_at: null };
      tenants.push(entry);
    }
    entry.visit_count = (entry.visit_count ?? 0) + 1;
    entry.last_selected_at = new Date(tst * 1000).toISOString();

    db.prepare('UPDATE learned_pois SET tenants = ? WHERE id = ?')
      .run(JSON.stringify(tenants), row.id);
    // Mirror into the visit detector so the next persist (delete-all +
    // reinsert from its in-memory list) keeps the tenants.
    if (visit?.setLearnedPoiTenants) visit.setLearnedPoiTenants(row.lat, row.lon, tenants);

    const date = localDate(tst);
    setVisitLabel(db, row.lat, row.lon, date, name);
    refreshJournal(date);
  }

  // Rename a learned POI in the DB and both in-memory detectors. Configured
  // POIs (Home, Work, …) aren't in learned_pois and are intentionally left
  // alone. If the old anchor name is in the tenant list, it follows the rename.
  function renameLearnedRow(row, newName) {
    const oldName = row.name;
    const tenants = parseTenants(row.tenants);
    const tenantEntry = tenants?.find(t => t.name === oldName);
    if (tenantEntry) tenantEntry.name = newName;

    db.prepare('UPDATE learned_pois SET name = ?, address = ?, tenants = ? WHERE id = ?')
      .run(newName, newName, tenants ? JSON.stringify(tenants) : null, row.id);
    // Keep in-memory state consistent so the next persist (delete-all +
    // reinsert from the visit detector) doesn't clobber the new name, and so
    // arrivals announce the corrected name immediately.
    if (visit?.renameLearnedPoi) visit.renameLearnedPoi(row.lat, row.lon, newName);
    if (tenants && visit?.setLearnedPoiTenants) visit.setLearnedPoiTenants(row.lat, row.lon, tenants);
    if (detector?.renameLocation) detector.renameLocation(oldName, newName);
    refreshJournal(localDate(nowTst()));
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

  function sendToChannel(message) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return null;
    return channel.send(message);
  }

  // Announce an arrival. Multi-tenant anchors (strip malls) get numbered
  // options with reaction shortcuts; everything else gets the plain message.
  async function sendArrival(location, tst) {
    const row = findLearnedPoi(location);
    const tenants = row ? parseTenants(row.tenants) : null;
    if (!tenants || tenants.length < 2) {
      await sendToChannel(`Arrived at ${location}`);
      return;
    }

    const names = orderTenants(tenants).slice(0, TENANT_EMOJI.length).map(t => t.name);
    const lines = [
      `Arrived at ${joinOr(names)} — react to pick:`,
      ...names.map((n, i) => `${TENANT_EMOJI[i]} ${n}`),
    ];
    const msg = await sendToChannel(lines.join('\n'));
    if (!msg) return;

    tenantPrompts[msg.id] = { lat: row.lat, lon: row.lon, tst: tst ?? nowTst(), tenants: names };
    saveTenantPrompts();
    for (let i = 0; i < names.length; i++) {
      await msg.react(TENANT_EMOJI[i]);
    }
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
          : `Currently at ${displayNameFor(location)}`;
        // Non-ephemeral so the user can reply to it: replying to "Roaming"
        // saves a new POI here, replying to "at X" corrects that place.
        await interaction.reply({ content });
      } catch (err) {
        console.error('Discord interaction error:', err.message);
      }
      return;
    }

    if (interaction.commandName === 'location-report') {
      try {
        const date = interaction.options.getString('date') || localDate(nowTst());

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

  // Tenant pick via reaction on a multi-business arrival prompt.
  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.id === client.user?.id || user.bot) return;
      if (reaction.partial) reaction = await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const ctx = tenantPrompts[reaction.message.id];
      if (!ctx) return;
      const idx = TENANT_EMOJI.indexOf(reaction.emoji.name);
      if (idx < 0 || idx >= ctx.tenants.length) return;

      const row = findLearnedPoiNear(ctx.lat, ctx.lon);
      if (!row) return;

      const name = ctx.tenants[idx];
      recordTenantSelection(row, name, ctx.tst);
      await reaction.message.reply(`✅ Logged **${name}** for this visit`);
    } catch (err) {
      console.error('Discord reaction error:', err.message);
    }
  });

  // Reply-to-correct: when the user replies to one of our location
  // notifications, the reply text corrects that place — christening a fresh
  // POI, or recording which business today's visit was actually to.
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

      const raw = message.content.trim();
      if (!raw) return;

      // Replying to "Currently Roaming" saves a brand-new POI at the current
      // position — for when the auto POI-lookup hasn't fired yet or the visit
      // guard suppressed it.
      if (isRoamingLocationMessage(referenced.content)) {
        const result = createLearnedLocationHere(raw);
        if (result.ok) {
          await message.reply(`✅ Saved **${raw}** as a POI here (${result.lat.toFixed(5)}, ${result.lon.toFixed(5)})`);
        } else if (result.reason === 'no_location') {
          await message.reply(`⚠️ No recent GPS fix to anchor a POI here.`);
        } else {
          await message.reply(`⚠️ Saving a POI is unavailable right now.`);
        }
        return;
      }

      const ctx = tenantPrompts[referenced.id];
      const parsed = ctx ? null : parseLocationMessage(referenced.content);
      if (!ctx && !parsed) return;

      if (!db) {
        await message.reply(`⚠️ Corrections are unavailable right now.`);
        return;
      }

      const row = ctx
        ? findLearnedPoiNear(ctx.lat, ctx.lon)
        : findLearnedPoi(parsed.name);
      if (!row) {
        await message.reply(`⚠️ Couldn't find a learned location matching that message — it may be a fixed POI from config.`);
        return;
      }

      // `rename:` always renames. Otherwise replies to the visit-flow
      // messages christen a freshly geocoded POI (as does any reply while the
      // anchor still has its auto-generated name); replies to an established
      // POI's messages record a tenant pick for today — the strip-mall case,
      // where the announced business is next door to the one actually visited.
      const renameMatch = raw.match(RENAME_PREFIX);
      const isChristening = parsed?.kind === 'poi_lookup' || parsed?.kind === 'visit_left'
        || /^Unknown \(/.test(row.name);

      if (renameMatch || isChristening) {
        const newName = (renameMatch ? renameMatch[1] : raw).trim();
        renameLearnedRow(row, newName);
        await message.reply(`✅ Renamed to **${newName}**`);
        return;
      }

      recordTenantSelection(row, raw, ctx?.tst ?? nowTst());
      await message.reply(
        `✅ Logged **${raw}** for today's visit to **${row.name}** (\`rename: <name>\` renames the POI itself)`
      );
    } catch (err) {
      console.error('Discord correction error:', err.message);
    }
  });

  return {
    start() {
      return client.login(token);
    },
    notify(message) {
      if (!ready) return;
      sendToChannel(message)?.catch?.(err => console.error('Discord notify error:', err));
    },
    // Arrival announcement with tenant options when the anchor has them.
    notifyArrival(location, tst) {
      if (!ready) return;
      sendArrival(location, tst).catch(err => console.error('Discord notify error:', err));
    },
    // "Left X" uses the name the journal will use for today's stay at X.
    notifyDeparture(location) {
      if (!ready) return;
      let display = location;
      try {
        display = displayNameFor(location);
      } catch (err) {
        console.error('Discord notify error:', err.message);
      }
      sendToChannel(`Left ${display} (now Roaming)`)?.catch?.(err => console.error('Discord notify error:', err));
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

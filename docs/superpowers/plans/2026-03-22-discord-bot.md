# Discord Bot Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord bot to the OwnTracks server that sends POI transition notifications and responds to a `/location` slash command.

**Architecture:** New `lib/discord.js` module integrated into the existing Express server via dependency injection. The discord.js client connects via gateway, registers a guild slash command, and exposes a `notify()` function called from the POST handler on POI transitions.

**Tech Stack:** discord.js, Node.js built-in test module, supertest

**Spec:** `docs/superpowers/specs/2026-03-22-discord-bot-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `lib/poi.js` | Add `previousLocation` to `detect()` return, add `getLocation()` method |
| Modify | `lib/__tests__/poi.test.js` | Update tests for new `detect()` return shape, add `getLocation()` tests |
| Modify | `server.js` | Accept `discord` in `createApp`, build notification messages, call `discord.notify()`, initialize Discord client at startup, graceful shutdown |
| Modify | `__tests__/server.test.js` | Add tests for Discord notification integration in POST handler |
| Create | `lib/discord.js` | Discord client module: `createDiscordClient()`, `notify()`, `/location` command |
| Create | `lib/__tests__/discord.test.js` | Unit tests for Discord module with mocked discord.js client |
| Modify | `.env.example` | Add `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_GUILD_ID` |
| Modify | `package.json` | Add `discord.js` dependency |

---

### Task 1: Update `detect()` to return `previousLocation`

**Files:**
- Modify: `lib/poi.js:18-30`
- Modify: `lib/__tests__/poi.test.js`

- [ ] **Step 1: Write failing tests for `previousLocation` in `detect()` return**

Add these tests to `lib/__tests__/poi.test.js` inside the `createPOIDetector` describe block:

```javascript
  it('detect returns previousLocation on transition (Roaming → Home)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(result.previousLocation, 'Roaming');
  });

  it('detect returns previousLocation on transition (Home → Roaming)', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.previousLocation, 'Home');
  });

  it('detect returns previousLocation matching location when no change', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    const result = detector.detect(FAR_AWAY.lat, FAR_AWAY.lon);
    assert.equal(result.previousLocation, 'Roaming');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: 3 failures — `result.previousLocation` is `undefined`

- [ ] **Step 3: Implement `previousLocation` in `detect()`**

In `lib/poi.js`, replace lines 28-30:

```javascript
// Before:
      const changed = current !== lastLocation;
      lastLocation = current;
      return { changed, location: current };

// After:
      const changed = current !== lastLocation;
      const previousLocation = lastLocation;
      lastLocation = current;
      return { changed, location: current, previousLocation };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/poi.js lib/__tests__/poi.test.js
git commit -m "feat: add previousLocation to detect() return value"
```

---

### Task 2: Add `getLocation()` method to POI detector

**Files:**
- Modify: `lib/poi.js:17-36`
- Modify: `lib/__tests__/poi.test.js`

- [ ] **Step 1: Write failing tests for `getLocation()`**

Add to `lib/__tests__/poi.test.js` inside the `createPOIDetector` describe block:

```javascript
  it('getLocation returns default Roaming state', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    assert.equal(detector.getLocation(), 'Roaming');
  });

  it('getLocation returns state after setLocation', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.setLocation('Home');
    assert.equal(detector.getLocation(), 'Home');
  });

  it('getLocation returns state after detect', () => {
    const detector = createPOIDetector(makeConfig([HOME]));
    detector.detect(NEAR_HOME.lat, NEAR_HOME.lon);
    assert.equal(detector.getLocation(), 'Home');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: 3 failures — `detector.getLocation is not a function`

- [ ] **Step 3: Implement `getLocation()`**

In `lib/poi.js`, add after the `setLocation` method (before the closing `};` of the return object):

```javascript
    getLocation() {
      return lastLocation;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/poi.test.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/poi.js lib/__tests__/poi.test.js
git commit -m "feat: add getLocation() method to POI detector"
```

---

### Task 3: Install discord.js dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install discord.js**

Run: `npm install discord.js`

- [ ] **Step 2: Verify it installed**

Run: `node -e "import('discord.js').then(d => console.log('discord.js loaded, version:', d.version))"`
Expected: Prints version number

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add discord.js dependency"
```

---

### Task 4: Create `lib/discord.js` module

**Files:**
- Create: `lib/discord.js`
- Create: `lib/__tests__/discord.test.js`

- [ ] **Step 1: Write failing tests for the Discord module**

Create `lib/__tests__/discord.test.js`:

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordClient } from '../discord.js';

// Minimal mock for discord.js Client
function createMockClient() {
  const handlers = {};
  let loggedIn = false;

  const mockChannel = {
    send: (msg) => {
      mockChannel.lastMessage = msg;
      return Promise.resolve();
    },
    lastMessage: null,
  };

  const mockGuild = {
    commands: {
      set: () => Promise.resolve(),
    },
  };

  return {
    client: {
      on: (event, handler) => { handlers[event] = handler; },
      once: (event, handler) => { handlers[event] = handler; },
      login: (token) => { loggedIn = true; return Promise.resolve(); },
      destroy: () => { loggedIn = false; },
      isReady: () => loggedIn,
      channels: {
        fetch: (id) => Promise.resolve(mockChannel),
      },
      guilds: {
        fetch: (id) => Promise.resolve(mockGuild),
      },
      user: { tag: 'TestBot#1234' },
    },
    handlers,
    mockChannel,
    simulateReady() { handlers.ready?.(); },
  };
}

describe('createDiscordClient', () => {
  it('notify no-ops when client is not ready', async () => {
    const { notify } = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector: null,
      makeClient: () => {
        const m = createMockClient();
        return m.client;
      },
    });
    // Should not throw
    await notify('test message');
  });

  it('notify sends message to the configured channel', async () => {
    const mock = createMockClient();
    const discord = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector: null,
      makeClient: () => mock.client,
    });
    await discord.start();
    mock.simulateReady();
    // Allow ready handler to complete
    await new Promise((r) => setTimeout(r, 10));
    await discord.notify('Arrived at Home');
    assert.equal(mock.mockChannel.lastMessage, 'Arrived at Home');
  });

  it('getReady returns false before start', () => {
    const mock = createMockClient();
    const discord = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector: null,
      makeClient: () => mock.client,
    });
    assert.equal(discord.getReady(), false);
  });

  it('handles /location interaction with detector', async () => {
    const mock = createMockClient();
    const detector = { getLocation: () => 'Home' };
    const discord = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector,
      makeClient: () => mock.client,
    });
    await discord.start();
    mock.simulateReady();

    // Simulate interaction
    const replied = { content: null, ephemeral: null };
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'location',
      reply: (opts) => { Object.assign(replied, opts); return Promise.resolve(); },
    };
    mock.handlers.interactionCreate(interaction);
    assert.equal(replied.content, 'Currently at Home');
    assert.equal(replied.ephemeral, true);
  });

  it('handles /location interaction without detector', async () => {
    const mock = createMockClient();
    const discord = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector: null,
      makeClient: () => mock.client,
    });
    await discord.start();
    mock.simulateReady();

    const replied = { content: null };
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'location',
      reply: (opts) => { Object.assign(replied, opts); return Promise.resolve(); },
    };
    mock.handlers.interactionCreate(interaction);
    assert.equal(replied.content, 'No location data available');
  });

  it('handles /location with Roaming state', async () => {
    const mock = createMockClient();
    const detector = { getLocation: () => 'Roaming' };
    const discord = createDiscordClient({
      token: 'fake-token',
      channelId: '123',
      guildId: '456',
      detector,
      makeClient: () => mock.client,
    });
    await discord.start();
    mock.simulateReady();

    const replied = { content: null };
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'location',
      reply: (opts) => { Object.assign(replied, opts); return Promise.resolve(); },
    };
    mock.handlers.interactionCreate(interaction);
    assert.equal(replied.content, 'Currently Roaming');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/__tests__/discord.test.js`
Expected: Failures — `createDiscordClient` module doesn't exist

- [ ] **Step 3: Implement `lib/discord.js`**

Create `lib/discord.js`:

```javascript
import { Client, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';

export function createDiscordClient({ token, channelId, guildId, detector, makeClient } = {}) {
  const client = makeClient
    ? makeClient()
    : new Client({ intents: [GatewayIntentBits.Guilds] });

  let ready = false;
  let channel = null;

  function getReady() {
    return ready;
  }

  async function start() {
    client.once('ready', async () => {
      ready = true;
      try {
        channel = await client.channels.fetch(channelId);
        const guild = await client.guilds.fetch(guildId);
        const command = new SlashCommandBuilder()
          .setName('location')
          .setDescription('Show current location');
        await guild.commands.set([command]);
        console.log(`Discord bot logged in as ${client.user.tag}`);
      } catch (err) {
        console.error('Discord setup error:', err.message);
      }
    });

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'location') return;

      try {
        if (!detector) {
          await interaction.reply({ content: 'No location data available', ephemeral: true });
          return;
        }

        const location = detector.getLocation();
        const message = location === 'Roaming'
          ? 'Currently Roaming'
          : `Currently at ${location}`;

        await interaction.reply({ content: message, ephemeral: true });
      } catch (err) {
        console.error('Discord interaction error:', err.message);
      }
    });

    await client.login(token);
  }

  async function notify(message) {
    if (!ready || !channel) return;
    try {
      await channel.send(message);
    } catch (err) {
      console.error('Discord notify error:', err.message);
    }
  }

  function destroy() {
    client.destroy();
    ready = false;
  }

  return { start, notify, getReady, destroy };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/__tests__/discord.test.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/discord.js lib/__tests__/discord.test.js
git commit -m "feat: add Discord client module with /location command"
```

---

### Task 5: Integrate Discord notifications into the POST handler

**Files:**
- Modify: `server.js:17,62-72`
- Modify: `__tests__/server.test.js`

- [ ] **Step 1: Write failing tests for Discord notification in POST handler**

Add to `__tests__/server.test.js`, after the existing `describe('POST /pub')` block:

```javascript
describe('POST /pub with discord', () => {
  const HOME = { name: 'Home', lat: 34.0170901, lon: -117.9025897 };
  const TARGET = { name: 'Target', lat: 34.0297163, lon: -117.9190439 };
  const NEAR_HOME = { lat: 34.0173, lon: -117.9026 };
  const NEAR_TARGET = { lat: 34.0297, lon: -117.9190 };
  const FAR_AWAY = { lat: 34.0215, lon: -117.9026 };

  function makeDetector(locations = [HOME]) {
    return createPOIDetector({
      poi: { default_radius_m: 100, locations },
    });
  }

  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    locationCalls.length = 0;
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('calls discord.notify with "Arrived at Home" on POI transition', async () => {
    const notified = [];
    const discord = { notify: (msg) => notified.push(msg) };
    const detector = makeDetector();
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });

    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: NEAR_HOME.lat, lon: NEAR_HOME.lon, tst: 1 });

    assert.equal(notified.length, 1);
    assert.equal(notified[0], 'Arrived at Home');
  });

  it('calls discord.notify with "Left Home (now Roaming)" when leaving POI', async () => {
    const notified = [];
    const discord = { notify: (msg) => notified.push(msg) };
    const detector = makeDetector();
    detector.setLocation('Home');
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });

    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: FAR_AWAY.lat, lon: FAR_AWAY.lon, tst: 1 });

    assert.equal(notified.length, 1);
    assert.equal(notified[0], 'Left Home (now Roaming)');
  });

  it('does not call discord.notify when location unchanged', async () => {
    const notified = [];
    const discord = { notify: (msg) => notified.push(msg) };
    const detector = makeDetector();
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });

    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: FAR_AWAY.lat, lon: FAR_AWAY.lon, tst: 1 });

    assert.equal(notified.length, 0);
  });

  it('calls discord.notify with "Arrived at Target" on POI-to-POI transition', async () => {
    const notified = [];
    const discord = { notify: (msg) => notified.push(msg) };
    const detector = makeDetector([HOME, TARGET]);
    detector.setLocation('Home');
    const appWithDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
      discord,
    });

    await request(appWithDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: NEAR_TARGET.lat, lon: NEAR_TARGET.lon, tst: 1 });

    assert.equal(notified.length, 1);
    assert.equal(notified[0], 'Arrived at Target');
  });

  it('works without discord instance (no crash)', async () => {
    const detector = makeDetector();
    const appNoDiscord = createApp({
      username: TEST_USER,
      password: TEST_PASS,
      dataDir: TEST_DATA_DIR,
      detector,
    });

    const res = await request(appNoDiscord)
      .post('/pub')
      .set('Authorization', basicAuth(TEST_USER, TEST_PASS))
      .send({ _type: 'location', lat: NEAR_HOME.lat, lon: NEAR_HOME.lon, tst: 1 });

    assert.equal(res.status, 200);
  });
});
```

Also add this import at the top of the file (after the existing imports):

```javascript
const { createPOIDetector } = await import('../lib/poi.js');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test __tests__/server.test.js`
Expected: Failures — `createApp` doesn't accept `discord`, no notification messages sent

- [ ] **Step 3: Update `createApp` to accept and use `discord`**

In `server.js`, make these changes:

1. Update the `createApp` signature at line 17:

```javascript
// Before:
export function createApp({ username, password, dataDir, detector } = {}) {

// After:
export function createApp({ username, password, dataDir, detector, discord } = {}) {
```

2. Replace the POI detection block (lines 62-72) with:

```javascript
    // POI detection
    if (
      detector &&
      typeof entry.lat === "number" &&
      typeof entry.lon === "number"
    ) {
      const result = detector.detect(entry.lat, entry.lon);
      if (result.changed) {
        log.location(`Location: ${result.location}`);

        // Discord notification
        if (discord) {
          const message = result.location === 'Roaming'
            ? `Left ${result.previousLocation} (now Roaming)`
            : `Arrived at ${result.location}`;
          discord.notify(message);
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test __tests__/server.test.js`
Expected: All tests pass (both old and new)

- [ ] **Step 5: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add server.js __tests__/server.test.js
git commit -m "feat: integrate Discord notifications into POST handler"
```

---

### Task 6: Add Discord startup and shutdown to `server.js`

**Files:**
- Modify: `server.js:87-128`
- Modify: `.env.example`

- [ ] **Step 1: Update `.env.example`**

Append to `.env.example`:

```
DISCORD_TOKEN=your-bot-token
DISCORD_CHANNEL_ID=your-channel-id
DISCORD_GUILD_ID=your-guild-id
```

- [ ] **Step 2: Update the startup block in `server.js`**

Add the import at the top of `server.js` (after existing imports):

```javascript
import { createDiscordClient } from "./lib/discord.js";
```

Replace the startup block (the `if (isDirectRun)` section) with:

```javascript
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
  let discord = null;
  const discordToken = process.env.DISCORD_TOKEN;
  const discordChannelId = process.env.DISCORD_CHANNEL_ID;
  const discordGuildId = process.env.DISCORD_GUILD_ID;

  if (discordToken && discordChannelId && discordGuildId) {
    discord = createDiscordClient({
      token: discordToken,
      channelId: discordChannelId,
      guildId: discordGuildId,
      detector,
    });
    discord.start().catch((err) => {
      log.error(`Discord failed to connect: ${err.message}`);
    });
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
```

- [ ] **Step 3: Run full test suite**

Run: `node --experimental-test-module-mocks --test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server.js .env.example lib/discord.js
git commit -m "feat: add Discord bot startup and graceful shutdown"
```

---

### Task 7: Configure `.env` and manual verification

- [ ] **Step 1: Add Discord credentials to `.env`**

Add the actual bot token, channel ID, and guild ID to `.env` (these must never be committed):

```
DISCORD_TOKEN=<the actual token>
DISCORD_CHANNEL_ID=540397251466362920
DISCORD_GUILD_ID=<the guild ID>
```

- [ ] **Step 2: Start the server and verify Discord connection**

Run: `npm run dev`
Expected: Console shows `Discord bot logged in as <bot-name>#<discriminator>`

- [ ] **Step 3: Test `/location` slash command**

In Discord, type `/location` in the channel.
Expected: Bot replies ephemerally with `Currently at Home` or `Currently Roaming`

- [ ] **Step 4: Test POI transition notification**

Run: `npm run curl:home` then `npm run curl:target`
Expected: Discord channel receives `Arrived at Home` then `Arrived at Target` (or similar based on current state)

- [ ] **Step 5: Verify server works without Discord env vars**

Temporarily remove Discord vars from `.env`, restart server.
Expected: Server starts normally, no Discord errors, location tracking works as before.

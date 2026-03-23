# Discord Bot Integration Design

## Overview

Add a Discord bot to the existing OwnTracks server process that:
1. Sends notifications to a Discord channel when POI transitions occur
2. Responds to a `/location` slash command with the current location status

## Architecture

The Discord bot runs inside the existing Express server process as a new module `lib/discord.js`. It connects to Discord via the gateway using `discord.js` and communicates with the rest of the app through a simple `notify()` function.

```
OwnTracks App → POST /pub → server.js → detector.detect()
                                           ↓ (if changed)
                                         discord.notify("Arrived at Home")

Discord User → /location → gateway → discord client → detector.getLocation() → replies
```

No new Express routes are needed. Slash command interactions are handled via the Discord gateway, not HTTP webhooks.

## Required Change: `lib/poi.js`

`detect()` currently overwrites `lastLocation` before returning, so the previous location is lost. Two changes needed:

1. **`detect()` returns `previousLocation`** — return `{ changed, location, previousLocation }` so callers can construct notification messages.
2. **Add `getLocation()` method** — returns the current `lastLocation` value, used by the Discord `/location` slash command to avoid re-parsing log files.

## Configuration

Three new environment variables in `.env`:

- `DISCORD_TOKEN` — Discord bot token
- `DISCORD_CHANNEL_ID` — Channel ID for notifications
- `DISCORD_GUILD_ID` — Guild (server) ID for slash command registration

All are optional. If any is missing, the Discord integration does not start and the server runs normally without it.

Add to `.env.example`:
```
DISCORD_TOKEN=your-bot-token
DISCORD_CHANNEL_ID=your-channel-id
DISCORD_GUILD_ID=your-guild-id
```

## Module: `lib/discord.js`

### Exports

`createDiscordClient({ token, channelId, guildId, detector })` — returns an object with:

- `start()` — logs in to Discord, registers the `/location` slash command as a guild command on ready
- `notify(message)` — sends a plain text message to the configured channel; no-ops if not connected; catches and logs errors internally (fire-and-forget, no unhandled rejections)
- `getReady()` — returns whether the client is connected and ready
- `destroy()` — calls `client.destroy()` for graceful shutdown

### Discord.js Client Config

- Intents: `Guilds` only (minimal footprint)
- No message content intent, no presence intent
- discord.js handles gateway reconnection and rate limiting internally — no custom logic needed

### Slash Command: `/location`

- Registered as a **guild command** (instant availability, no propagation delay) using `commands.set()` which is idempotent — safe to call on every startup
- Replies ephemerally (only visible to the invoking user)
- Calls `detector.getLocation()` to get the current location from in-memory state
- Response format:
  - At a POI: `Currently at Home`
  - Roaming: `Currently Roaming`
- If detector was not provided to the Discord client: `No location data available`

## Notification Messages

Sent as plain text to the configured channel:

| Transition | Message |
|---|---|
| Enter a POI (from Roaming) | `Arrived at Home` |
| Leave a POI (to Roaming) | `Left Home (now Roaming)` |
| Move between POIs | `Arrived at Target` |

The message is determined in `server.js` using `previousLocation` and `location` from the `detect()` return value. Logic:
- If new location is not "Roaming": `Arrived at {location}` (covers both entering from Roaming and POI-to-POI transitions)
- If new location is "Roaming": `Left {previousLocation} (now Roaming)`

## Integration with `server.js`

### Startup

After loading config and creating the POI detector:

1. Read `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and `DISCORD_GUILD_ID` from env
2. If all three are present, call `createDiscordClient({ token, channelId, guildId, detector })` and `start()`. `start()` is fire-and-forget with `.catch(log)` — do not await, so the server starts even if Discord fails.
3. Pass the discord instance into `createApp({ username, password, dataDir, detector, discord })` via dependency injection. The `discord` parameter is optional — `createApp` works without it, and all existing tests remain unaffected.

### Request Handler (`POST /pub`)

After `detector.detect()` returns `changed: true`:

1. Determine the notification message using `location` and `previousLocation`
2. Call `discord.notify(message)` — fire-and-forget, do not await
3. Continue with the normal response

The Discord notification must not block or affect the HTTP response.

### Graceful Shutdown

Call `discord.destroy()` during shutdown (e.g., SIGUSR2 handler for nodemon) to cleanly disconnect the gateway connection.

## Error Handling

- **Connection failure:** Log a warning, do not crash the server. The server should function normally without Discord.
- **`notify()` failure:** Caught internally, logged as a warning. No unhandled rejections, no effect on HTTP response.
- **Slash command failure:** Reply with an error message ephemerally.

## Dependencies

- `discord.js` — added to `package.json`

## Bot Setup Requirements

The Discord bot requires:
- `applications.commands` OAuth2 scope (for slash command registration)
- `Send Messages` permission in the notification channel
- `bot` OAuth2 scope

## Testing

- `notify()` no-ops gracefully when client is not connected
- `notify()` sends to the correct channel when connected
- `createApp` works with and without a discord instance (existing tests unaffected)
- Notification messages are correctly formatted for each transition type
- `/location` returns correct format for POI and Roaming states
- `/location` returns fallback message when detector is not available
- `detect()` returns `previousLocation` correctly (update existing poi tests)
- `getLocation()` returns current state after `detect()` or `setLocation()`

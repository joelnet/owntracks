# OwnTracks Location Journal

A self-hosted Node.js server that receives location data from the [OwnTracks](https://owntracks.org/) mobile app, detects POI visits and activity state (stationary/walking/driving), and sends notifications to Discord.

## Architecture

```
Phone (OwnTracks app)
  → HTTPS POST (JSON)
    → Cloudflare Tunnel (owntracks.yourdomain.com)
      → Node.js server (Raspberry Pi, localhost:3000)
        → POI detection (geofence with Haversine distance)
        → Activity detection (windowed speed classification)
        → Discord notifications (arrivals, departures, activity changes)
        → JSONL data storage (daily files)
```

## Prerequisites

- Raspberry Pi (or any Linux server) running 24/7
- Node.js 18+
- A domain name with DNS managed by Cloudflare
- OwnTracks app installed on your phone ([Android](https://play.google.com/store/apps/details?id=org.owntracks.android) / [iOS](https://apps.apple.com/app/owntracks/id692424691))

## Installation

```bash
git clone <repo-url>
cd owntracks-journal
npm install
cp .env.example .env
# Edit .env with your settings
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```env
PORT=3000
OWNTRACKS_USERNAME=joel
OWNTRACKS_PASSWORD=your-secret-password

# Discord (optional — server runs fine without these)
DISCORD_TOKEN=your-bot-token
DISCORD_CHANNEL_ID=your-channel-id
DISCORD_GUILD_ID=your-guild-id
```

### POI and Activity Detection

Edit `config.yml` to define your points of interest and activity detection settings:

```yaml
poi:
  default_radius_m: 100
  locations:
    - name: Home
      lat: 34.0170901
      lon: -117.9025897
      radius_m: 250        # optional per-POI override
    - name: Target
      lat: 34.0297163
      lon: -117.9190439

activity:
  enabled: true
  discord_notifications: true    # send Walking/Driving/Stationary to Discord
  dwell_threshold_minutes: 5     # time at low speed before "Stationary"
  walking_max_kmh: 7             # below this = walking or stationary
  driving_min_kmh: 25            # above this = driving
  window_size: 5                 # GPS points in sliding window
```

The `activity` section is optional. Remove it to disable activity detection entirely. Set `discord_notifications: false` to detect activity without sending Discord messages.

## Running

```bash
# Development (auto-restart on changes)
npx nodemon server.js

# Production
node server.js

# Run tests
npm test
```

## Setup Guides

- [OwnTracks App Setup](docs/owntracks-setup.md) — configure the mobile app to send location data to your server
- [Cloudflare Tunnel Setup](docs/cloudflare-tunnel.md) — expose the server to the internet without opening ports

## Features

### POI Detection

Detects when you arrive at or leave configured locations using Haversine distance. Sends Discord notifications:
- `Arrived at Home`
- `Left Home (now Roaming)`

### Activity Detection

Classifies movement state using a sliding window of GPS points, inspired by [GeoPulse](https://github.com/tess1o/geopulse). Four states:
- **Stationary** — below walking speed for longer than `dwell_threshold_minutes`
- **Walking** — speed between 0 and `driving_min_kmh`
- **Driving** — speed above `driving_min_kmh`
- **Unknown** — initial state while the window fills (no notifications)

Uses median speed across the window with debounce (2 consecutive agreeing points) to avoid false transitions from GPS noise. Activity state persists across server restarts via `data/activity-state.json`.

### Discord Bot

Sends notifications to a Discord channel and provides a `/location` slash command. Requires a Discord bot with `bot` and `applications.commands` OAuth2 scopes and `Send Messages` permission.

## Project Structure

```
owntracks/
├── server.js              # Express server, POST /pub endpoint, startup wiring
├── config.yml             # POI locations and activity detection config
├── lib/
│   ├── activity.js        # Activity state detection (windowed speed classifier)
│   ├── config.js          # YAML config loader and validator
│   ├── discord.js         # Discord bot client and /location command
│   ├── logger.js          # Logging (daily files + location log)
│   ├── poi.js             # POI detection (Haversine geofencing)
│   ├── store.js           # JSONL data storage (daily files)
│   └── __tests__/         # Unit tests for each module
├── __tests__/
│   └── server.test.js     # Integration tests
├── data/                  # Location data (JSONL) and activity state
├── logs/                  # Application and location logs
├── .env                   # Secrets (not committed)
└── .env.example           # Example configuration
```

## License

MIT

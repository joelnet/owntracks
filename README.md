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

## OwnTracks App Setup

1. Install OwnTracks on your phone
2. Open Settings → Connection
3. Set **Mode** to **HTTP**
4. Set **URL** to `https://owntracks.yourdomain.com/owntracks`
5. Under **Identification**, set your username and password (must match `.env`)
6. Optionally configure regions/waypoints for zone enter/leave events

### OwnTracks Payload Format

The app POSTs JSON to your endpoint. A location payload looks like:

```json
{
  "_type": "location",
  "lat": 33.9900,
  "lon": -117.8700,
  "tst": 1711036800,
  "acc": 15,
  "alt": 50,
  "batt": 85,
  "vel": 0,
  "conn": "w",
  "tid": "JL"
}
```

Key fields:

| Field  | Description                              |
|--------|------------------------------------------|
| `lat`  | Latitude                                 |
| `lon`  | Longitude                                |
| `tst`  | Unix timestamp of the location fix       |
| `acc`  | Accuracy in meters                       |
| `vel`  | Velocity (km/h)                          |
| `conn` | Connection type (`w` = WiFi, `m` = cell) |
| `batt` | Battery percentage                       |
| `tid`  | Tracker ID (2-char identifier)           |

Transition events (zone enter/leave) have `_type: "transition"` with an `event` field of `"enter"` or `"leave"` and a `desc` field with the zone name.

## Cloudflare Tunnel Setup

Cloudflare Tunnel allows you to expose the server to the internet without opening ports or needing a static IP. Traffic flows through Cloudflare's network, and the `cloudflared` daemon on your Pi maintains an outbound connection — nothing is directly exposed.

### 1. Install cloudflared

```bash
# ARM64 (Raspberry Pi 4/5, 64-bit OS)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# ARM 32-bit (older Pi or 32-bit OS)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# x86_64
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

### 2. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This prints a URL. Open it in a browser, log into your Cloudflare account, and select the domain you want to use (e.g., `yourdomain.com`). A certificate is saved to `~/.cloudflared/cert.pem`.

### 3. Create the tunnel

```bash
cloudflared tunnel create owntracks
```

Note the **tunnel UUID** printed in the output. A credentials file is created at `~/.cloudflared/<UUID>.json`.

### 4. Create the config file

```bash
nano ~/.cloudflared/config.yml
```

```yaml
tunnel: <UUID>
credentials-file: /home/<your-user>/.cloudflared/<UUID>.json

ingress:
  - hostname: owntracks.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Replace `<UUID>` with your tunnel UUID and `<your-user>` with your Pi username. The catch-all `http_status:404` rule at the end is required by cloudflared.

### 5. Create the DNS record

```bash
cloudflared tunnel route dns owntracks owntracks.yourdomain.com
```

This adds a CNAME record in Cloudflare DNS pointing your subdomain to the tunnel. You can verify it in the Cloudflare dashboard under DNS.

### 6. Test the tunnel

```bash
cloudflared tunnel run owntracks
```

You should see connection logs. Verify by visiting `https://owntracks.yourdomain.com` in a browser.

### 7. Install as a systemd service

The config and credentials must be in `/etc/cloudflared/` for the systemd service to find them (since it runs as root, `~/` resolves to `/root/`):

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
```

Update the credentials path in the copied config:

```bash
sudo nano /etc/cloudflared/config.yml
```

Change `credentials-file` to:

```yaml
credentials-file: /etc/cloudflared/<UUID>.json
```

Then install and start the service:

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

### Adding more hostnames to the tunnel

You can route multiple services through the same tunnel by adding more ingress rules to the config:

```yaml
ingress:
  - hostname: owntracks.yourdomain.com
    service: http://localhost:3000
  - hostname: other-service.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

Then add DNS records for each:

```bash
cloudflared tunnel route dns owntracks other-service.yourdomain.com
```

Restart cloudflared after config changes:

```bash
sudo systemctl restart cloudflared
```

### Security notes

- The tunnel does **not** expose your public IP. DNS resolves to Cloudflare's IPs.
- Only services explicitly listed in `ingress` are reachable. SSH, other ports, etc. are not exposed.
- Subdomains can be discovered via DNS enumeration or Certificate Transparency logs (e.g., crt.sh).
- For additional security, configure [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) to add authentication in front of your service.
- OwnTracks uses HTTP Basic Auth over HTTPS. The Cloudflare tunnel provides TLS termination automatically.

### Troubleshooting

```bash
# Check tunnel status
sudo systemctl status cloudflared

# View logs
sudo journalctl -u cloudflared -f

# Verify DNS resolution
dig owntracks.yourdomain.com

# Test tunnel manually (foreground)
cloudflared tunnel --config /etc/cloudflared/config.yml run owntracks

# List tunnels
cloudflared tunnel list

# Delete a tunnel (must delete DNS routes first)
cloudflared tunnel route dns -d owntracks owntracks.yourdomain.com
cloudflared tunnel delete owntracks
```

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

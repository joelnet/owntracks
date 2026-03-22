# OwnTracks Location Receiver — Phase 1 Design

## Overview

A Node.js Express server that receives location data from the OwnTracks mobile app via HTTP POST and stores it as daily JSONL files. The server runs on port 3000 behind a Cloudflare Tunnel at `owntracks.joel.net`.

## Endpoint

### `POST /pub`

Receives OwnTracks JSON payloads. Follows the OwnTracks Recorder convention for endpoint path.

**Authentication:** HTTP Basic Auth. The server validates the `Authorization` header against `OWNTRACKS_USERNAME` and `OWNTRACKS_PASSWORD` from `.env`. The authenticated username takes precedence over the `X-Limit-U` header (matching the nginx/Recorder pattern where `$remote_user` overwrites client-supplied identity).

**Identity extraction:**
- `username`: from authenticated Basic Auth credentials
- `device`: from `X-Limit-D` header, falling back to `"phone"` if absent

**Responses:**
- `200` with `[]` (empty JSON array) — success. This is what the OwnTracks app expects.
- `401` — missing or invalid credentials
- `400` — unparseable request body

## Storage

### JSONL files

One file per day in the `data/` directory:

```
data/
  2026-03-22.jsonl
  2026-03-23.jsonl
```

Each line is a self-contained JSON object:

```json
{"username":"joel","device":"phone","lat":33.99,"lon":-117.87,"tst":1711036800,"acc":15,"alt":50,"batt":85,"vel":0,"conn":"w","tid":"JL","type":"location","received_at":"2026-03-22T15:30:00.000Z"}
```

**Fields:**
- All fields from the OwnTracks payload are passed through as-is (future-proof)
- `type`: renamed from `_type` in the payload (e.g. `location`, `transition`)
- `username`: server-assigned from authenticated identity
- `device`: from `X-Limit-D` header or default `"phone"`
- `received_at`: ISO 8601 timestamp of when the server received the request

The `data/` directory is created on startup if it doesn't exist and is gitignored.

## Project Structure

```
owntracks-journal/
├── server.js           # Express app, auth middleware, POST /pub handler
├── lib/
│   └── store.js        # JSONL file append logic
├── data/               # JSONL files (created at runtime, gitignored)
├── .env                # Credentials (not committed)
├── .env.example        # Template
├── .gitignore
├── package.json
└── README.md
```

## Dependencies

- `express` — HTTP framework
- `dotenv` — load `.env` configuration

## Configuration

Environment variables in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server listen port | `3000` |
| `OWNTRACKS_USERNAME` | Expected Basic Auth username | (required) |
| `OWNTRACKS_PASSWORD` | Expected Basic Auth password | (required) |

## Out of Scope (Future Phases)

- Visit detection logic
- Reverse geocoding (Nominatim / Google Places)
- Claude via MCP integration
- Friend location sharing (non-empty response arrays)
- Transition event handling beyond storage

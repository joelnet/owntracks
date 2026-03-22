# OwnTracks App Setup

1. Install OwnTracks on your phone
2. Open Settings → Connection
3. Set **Mode** to **HTTP**
4. Set **URL** to `https://owntracks.yourdomain.com/owntracks`
5. Under **Identification**, set your username and password (must match `.env`)
6. Optionally configure regions/waypoints for zone enter/leave events

## Payload Format

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

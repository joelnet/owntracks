---
name: owntracks-read-logs
description: Read and summarize OwnTracks service logs from journald on this project host. Use when the user asks for logs, errors, startup output, crash history, recent service activity, Discord connection messages, systemd status details, or troubleshooting information for owntracks.service.
---

# OwnTracks Read Logs

## Workflow

Read bounded recent logs by default:

```bash
sudo -n journalctl -u owntracks.service -n 120 --no-pager
```

For service state, pair logs with status:

```bash
systemctl status owntracks.service --no-pager
```

Use a larger bounded read only when the user asks for more history:

```bash
sudo -n journalctl -u owntracks.service -n 300 --no-pager
```

Use time filters when the user gives a time window:

```bash
sudo -n journalctl -u owntracks.service --since "2026-05-11 13:00" --until "2026-05-11 14:00" --no-pager
```

## Live Tailing

Use live tailing only when the user explicitly asks to follow logs:

```bash
sudo -n journalctl -u owntracks.service -f
```

Do not leave a follow session running at the end of the turn. Stop it after collecting enough lines to answer.

## What To Look For

Call out:

- service start/stop/restart timestamps;
- `Server started on port 3000`;
- `Discord bot ready`;
- uncaught exceptions or unhandled rejections;
- repeated restart loops;
- systemd failures, timeouts, or non-zero exits.

If `sudo -n` fails with a password prompt or permission error, say that the narrow sudoers rule is missing or not active and do not retry interactively.

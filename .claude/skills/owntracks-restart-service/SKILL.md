---
name: owntracks-restart-service
description: Restart and verify the OwnTracks systemd service on this project host. Use when the user asks to restart, bounce, reload, recover, or check whether Codex/Claude can manage owntracks.service after code, config, dependency, or deployment changes.
---

# OwnTracks Restart Service

## Workflow

Restart only the project service:

```bash
sudo -n systemctl restart owntracks.service
```

Then verify it is healthy:

```bash
systemctl status owntracks.service --no-pager
```

If status is not clearly healthy, read recent logs:

```bash
sudo -n journalctl -u owntracks.service -n 80 --no-pager
```

## Expected Healthy State

Treat the restart as successful when all are true:

- `Active: active (running)` appears in status.
- The service is loaded from `/etc/systemd/system/owntracks.service`.
- Logs show `Server started on port 3000`.
- Logs show `Discord bot ready` unless Discord credentials are intentionally absent.

## Reporting

Summarize the outcome with:

- whether the restart command succeeded;
- the active state and main PID from `systemctl status`;
- the newest startup lines from journald;
- any warning, failure, or missing-health signal.

If the restart command fails because `sudo -n` requires a password or permission is denied, say that the narrow sudoers rule is missing or not active and do not retry interactively.

# systemd setup

Run OwnTracks as a native systemd service so it starts after reboot and restarts after Node exits unexpectedly.

## Install the service

```bash
sudo cp deploy/owntracks.service /etc/systemd/system/owntracks.service
sudo systemctl daemon-reload
sudo systemctl enable owntracks.service
sudo systemctl start owntracks.service
```

Check status and logs:

```bash
systemctl status owntracks.service --no-pager
sudo journalctl -u owntracks.service -f
```

## Limited sudo access for service management

Claude/Codex normally runs as `joel`, not root. Automatic crash recovery and boot startup do not need Claude/Codex access, because systemd handles those itself. Manual restarts from Claude/Codex need a narrow sudoers rule.

Install the provided sudoers drop-in:

```bash
sudo cp deploy/owntracks-sudoers /etc/sudoers.d/owntracks-service
sudo chmod 0440 /etc/sudoers.d/owntracks-service
sudo visudo -cf /etc/sudoers.d/owntracks-service
```

After that, `joel` can run only the listed service-management commands without a password:

```bash
sudo -n systemctl restart owntracks.service
systemctl status owntracks.service --no-pager
sudo -n journalctl -u owntracks.service -f
```

Validate that unrelated sudo commands still require normal authorization:

```bash
sudo -n true
```

That command should fail unless `joel` already has broader passwordless sudo from another rule.

## Restart behavior

The service uses `Restart=on-failure`.

- If Node exits with a non-zero code, systemd restarts it after 5 seconds.
- If Node crashes from a fatal signal, systemd restarts it after 5 seconds.
- If the server reboots, systemd starts the service because it is enabled.
- If you run `sudo systemctl stop owntracks.service`, systemd treats that as intentional and does not restart it.
- If Node exits cleanly with code 0, systemd does not restart it.

The app handles `SIGTERM` and `SIGINT` by closing the HTTP server, Discord client, and SQLite database before exiting. Uncaught exceptions and unhandled promise rejections are logged, cleaned up, and then exited with code 1 so systemd can restart the service.

## Operational commands

```bash
sudo systemctl restart owntracks.service
sudo systemctl stop owntracks.service
sudo systemctl start owntracks.service
systemctl status owntracks.service --no-pager
sudo journalctl -u owntracks.service -f
```

Test automatic restart:

```bash
systemctl show -p MainPID --value owntracks.service
sudo kill -KILL "$(systemctl show -p MainPID --value owntracks.service)"
sleep 7
systemctl status owntracks.service --no-pager
```

Test boot startup:

```bash
sudo reboot
```

After the machine comes back:

```bash
systemctl status owntracks.service --no-pager
systemctl status cloudflared.service --no-pager
```

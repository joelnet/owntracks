# Cloudflare Tunnel Setup

Cloudflare Tunnel allows you to expose the server to the internet without opening ports or needing a static IP. Traffic flows through Cloudflare's network, and the `cloudflared` daemon on your Pi maintains an outbound connection — nothing is directly exposed.

## 1. Install cloudflared

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

## 2. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This prints a URL. Open it in a browser, log into your Cloudflare account, and select the domain you want to use (e.g., `yourdomain.com`). A certificate is saved to `~/.cloudflared/cert.pem`.

## 3. Create the tunnel

```bash
cloudflared tunnel create owntracks
```

Note the **tunnel UUID** printed in the output. A credentials file is created at `~/.cloudflared/<UUID>.json`.

## 4. Create the config file

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

## 5. Create the DNS record

```bash
cloudflared tunnel route dns owntracks owntracks.yourdomain.com
```

This adds a CNAME record in Cloudflare DNS pointing your subdomain to the tunnel. You can verify it in the Cloudflare dashboard under DNS.

## 6. Test the tunnel

```bash
cloudflared tunnel run owntracks
```

You should see connection logs. Verify by visiting `https://owntracks.yourdomain.com` in a browser.

## 7. Install as a systemd service

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

## Adding more hostnames to the tunnel

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

## Security notes

- The tunnel does **not** expose your public IP. DNS resolves to Cloudflare's IPs.
- Only services explicitly listed in `ingress` are reachable. SSH, other ports, etc. are not exposed.
- Subdomains can be discovered via DNS enumeration or Certificate Transparency logs (e.g., crt.sh).
- For additional security, configure [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) to add authentication in front of your service.
- OwnTracks uses HTTP Basic Auth over HTTPS. The Cloudflare tunnel provides TLS termination automatically.

## Troubleshooting

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

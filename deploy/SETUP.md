# One-off setup to put the portal online (fabricated data only)

Steps marked **(root)** need `sudo` as `calloutcomputers`. Steps marked **(portal)** run as the `portal` user.
Steps marked **(dashboard)** happen in the Cloudflare dashboard.

⚠ The Cloudflare account also holds `stspro.co.uk`, which is unrelated. Wherever a zone is chosen, pick
**swaletutoring.co.uk**. Never touch the apex MX / SPF / DKIM / DMARC records, because M365 mail is live.

## 1. Build and configure (portal)

```bash
cd ~/app && npm ci && npm run build
cp .env.example .env && chmod 600 .env      # fill in ACCESS_TEAM_DOMAIN and ACCESS_AUD after step 3
```

## 2. Tunnel (root)

```bash
# cloudflared from Cloudflare's own apt repository
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

sudo cloudflared tunnel login                 # opens a URL: choose swaletutoring.co.uk
sudo cloudflared tunnel create swale-portal   # prints the tunnel id
sudo cloudflared tunnel route dns swale-portal portal.swaletutoring.co.uk   # adds ONE CNAME, nothing else
```

Copy `deploy/cloudflared-config.yml` to `/etc/cloudflared/config.yml`, put the tunnel ID in both places, and move
the credentials JSON from `/root/.cloudflared/` to `/etc/cloudflared/`. Then:

```bash
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

## 3. Access (dashboard)

Go to Zero Trust → Access → Applications → Add → **Self-hosted**.

- Domain: `portal.swaletutoring.co.uk`
- Policy: **Allow**, include **Emails**, listing each person individually (no domain-wide rules)
- Login method: **One-time PIN** only
- Session duration: **1 week**. The phone queues work while signed out, so expiry never loses data.
- From the application's overview, copy the **Application Audience (AUD) tag**, plus your team domain
  (`<team>.cloudflareaccess.com`), into `/srv/portal/app/.env`.

## 4. Services (root)

```bash
sudo cp /srv/portal/app/deploy/portal.service /srv/portal/app/deploy/portal-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now portal.service portal-backup.timer
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/me   # expect 403: no Access token
```

## 5. People (portal)

```bash
set -a; . ./.env; set +a
npm run cli -- seed-test                                  # fabricated tutors and pupils
npm run cli -- user-add <you> "Lars" admin
npm run cli -- assign TEST-001 <you>                     # so the admin can try the tutor screens
```

## 6. Backups (root)

Add `/srv/portal/backup` and `/srv/portal/files` to the restic include list used by the nightly Umbrel job.
**Not** `/srv/portal/data`: that's the live database. Then run a restore test: restore last night's snapshot to a
scratch path and run `sqlite3 <file> 'PRAGMA integrity_check; SELECT COUNT(*) FROM sessions;'`.

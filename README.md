# Swale Tutoring Placement Portal

A phone app (PWA) for Swale Tutoring Service Ltd tutors. Slice 1 records **session times** on the pupil's
attendance record and the **Lesson Summary** form, and works offline.

The *why* is in `07_Operations_Brand/Placement_Portal_Spec.md` and the *what* in
`Placement_Portal_Build_Brief.md`, both in the Swale project folder. Read the brief's §1 and §12 before changing anything.

## Rules that are not negotiable

- **Wording:** "session", "arrived", "attendance". Never "clock in/out", "shift", "hours worked" or "timesheet".
  Nothing here calculates or exports tutor pay. Tutors are self-employed, so this wording has IR35 consequences.
- **No GPS or location capture.**
- **Never show "sent" for anything still queued on the phone.**
- **A tutor sees only their own pupils.** This is enforced server-side in every query.
- **No real pupil data until the DPIA is signed off.** Until then, use fabricated data only (`TEST-` references, `example.test` emails).
- The app **only listens on 127.0.0.1**. The only way in is Cloudflare Tunnel → Access. `src/server/config.ts` refuses any other `HOST`.

## How it fits together

| Layer | What |
|---|---|
| Phone | Vanilla TypeScript + Vite PWA. IndexedDB holds the offline queue and the tutor's sessions. The service worker caches the app shell. |
| Auth | Cloudflare Access (email one-time PIN). `src/server/auth.ts` verifies the `Cf-Access-Jwt-Assertion` RS256 signature, `iss`, `aud` and `exp` against Cloudflare's keys, then looks the email up in `users`. |
| Server | Node 22 + Fastify, `src/server`. Every write is idempotent on the device-generated `client_uuid` and writes an `audit_log` row in the same transaction. |
| Data | SQLite at `/srv/portal/data/portal.db` (outside the repo). The schema is in `migrations/`, applied on start. |
| Host | `server136`, user `portal`, home `/srv/portal`. Isolated from everything else on the box. |

## Working on it

Everything runs on the server as `portal` (`ssh portal@185.32.72.150`). Node 22 is in `~/.local/opt/node/bin`.

```bash
npm install
npm test             # acceptance tests 1, 2, 3, 5, 6, 7 and more (in-memory DB, test signing keys)
npm run typecheck
npm run build        # dist/client (the PWA) and dist/server
npx tsx scripts/dev-server.ts   # the real app behind a stand-in for Access, on 127.0.0.1:3199
```

To try the dev server from a PC: `ssh -N -L 3199:127.0.0.1:3199 portal@185.32.72.150`, then open
http://localhost:3199. Open `/__as/tutor-b@example.test` to switch user. It uses its own throwaway DB in `~/dev-data`.

## Admin

With the production `.env` loaded (`set -a; . ./.env; set +a`):

```bash
npm run cli -- user-add someone@example.com "Display Name" tutor   # tutor | dsl | deputy | admin
npm run cli -- assign TEST-001 someone@example.com
npm run cli -- user-deactivate someone@example.com                 # also remove them from the Access policy
npm run cli -- users
npm run cli -- retention-due    # pupils past their 25th birthday, due a retention review (deletes nothing)
```

Adding someone takes two steps: add them here **and** to the Cloudflare Access policy. Removing someone likewise takes both.

## Deploying

`deploy/` holds the systemd units, the backup timer and the cloudflared config. The one-off root setup is in
`deploy/SETUP.md`.

## Backups

`scripts/backup-db.sh` takes a consistent `.backup` snapshot at 02:45 UTC into `/srv/portal/backup`, ahead of
restic's 03:00 run. **Never** point restic at the live `portal.db`. A restore must be tested before any real data goes in.

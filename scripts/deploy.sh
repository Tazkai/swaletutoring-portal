#!/usr/bin/env bash
# Deploys GitHub main to the live portal. Run as the portal user.
# Development happens in ~/dev; the live checkout (/srv/portal/app) changes only through here,
# so a build in progress can never be served alongside an old server.
set -euo pipefail
export PATH="$HOME/.local/opt/node/bin:$PATH"
cd /srv/portal/app

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy: the live checkout has local changes. Refusing." >&2
  git status --short >&2
  exit 1
fi

git fetch -q origin
git merge -q --ff-only origin/main
npm ci --no-audit --no-fund --silent
npm test --silent >/dev/null || { echo "deploy: tests failed; live service untouched." >&2; exit 1; }
npm run -s build >/dev/null
# The one root command the portal user is allowed (see /etc/sudoers.d/portal-restart).
sudo -n /usr/bin/systemctl restart portal.service

for _ in 1 2 3 4 5; do
  sleep 1
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/me || true)
  [ "$code" = 403 ] && break
done
if [ "$code" != 403 ]; then
  echo "deploy: health check failed (HTTP $code). Check: journalctl -u portal" >&2
  exit 1
fi
echo "Deployed $(git log --oneline -1)"

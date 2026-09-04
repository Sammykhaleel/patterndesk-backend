#!/usr/bin/env bash
#
# Ships the server directory to the VM and restarts it. Run this from YOUR
# machine, from anywhere inside the repo:
#
#   bash server/deploy/oracle/deploy.sh ubuntu@129.153.x.x
#   bash server/deploy/oracle/deploy.sh opc@129.153.x.x        # Oracle Linux image
#   SKIP_TESTS=1 bash server/deploy/oracle/deploy.sh ubuntu@129.153.x.x
#
# Works from Git Bash on Windows: it needs only `ssh` and `tar`, both of which
# ship with Git for Windows. There is deliberately no rsync dependency.
#
# .env is never transferred. It lives on the VM and only on the VM — that is
# the whole point of not having the keys on a laptop that travels.

set -euo pipefail

TARGET=${1:-}
APP_USER=${APP_USER:-patterndesk}
APP_DIR=${APP_DIR:-/opt/patterndesk/server}
PORT=${PORT:-3000}
SKIP_TESTS=${SKIP_TESTS:-0}

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)   # .../patterndesk/server

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mfailed:\033[0m %s\n\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || die "usage: bash deploy.sh <user>@<vm-ip>"
[ -f "$SRC/server.js" ] || die "expected server.js in $SRC — is this script still inside server/deploy/oracle/?"

say "Source"
printf '   %s\n   -> %s:%s\n' "$SRC" "$TARGET" "$APP_DIR"

# The upload pipes a tarball into `sudo tar x`. If sudo stops to ask for a
# password it swallows the archive instead, and the failure looks like a
# corrupt transfer. Check first. (OCI's stock images are passwordless.)
ssh -o BatchMode=yes "$TARGET" 'sudo -n true' 2>/dev/null \
  || die "passwordless sudo is not available for $TARGET — the upload would hang on the prompt."

# setup.sh creates the user the tarball is chowned to.
ssh "$TARGET" "id $APP_USER >/dev/null 2>&1" \
  || die "user '$APP_USER' does not exist on the VM. Run setup.sh there first (see README.md)."

# Fail fast locally rather than shipping something that will not start.
if [ "$SKIP_TESTS" != "1" ] && command -v node >/dev/null 2>&1 && [ -d "$SRC/node_modules" ]; then
  say "Tests (local)"
  ( cd "$SRC" && npm test --silent ) || die "tests failed — nothing was deployed."
fi

say "Upload"
# --exclude=.env matches that name exactly, so .env.example still ships.
tar czf - -C "$SRC" \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=.env \
    --exclude='*.log' \
    . \
  | ssh "$TARGET" "sudo install -d -o $APP_USER -g $APP_USER -m 750 $APP_DIR \
      && sudo tar xzf - -C $APP_DIR \
      && sudo chown -R $APP_USER:$APP_USER $APP_DIR \
      && sudo chmod +x $APP_DIR/deploy/oracle/*.sh" \
  || die "upload failed. Check the SSH target and that setup.sh has been run."

say "Install + restart"
ssh "$TARGET" "set -e
  cd $APP_DIR
  # -H matters: without it sudo leaves HOME pointing at the SSH user, and npm
  # fails trying to write its cache into a directory $APP_USER cannot touch.
  sudo -u $APP_USER -H npm ci --omit=dev --no-audit --no-fund
  if [ ! -f $APP_DIR/.env ]; then
    echo
    echo '  Code is in place, but there is no .env yet, so the service was not started.'
    echo '  Write it, then start:'
    echo
    echo '    sudo -u $APP_USER cp $APP_DIR/.env.example $APP_DIR/.env'
    echo '    sudo -u $APP_USER nano $APP_DIR/.env'
    echo '    sudo chmod 600 $APP_DIR/.env'
    echo '    sudo systemctl start patterndesk'
    echo
    exit 0
  fi
  sudo chmod 600 $APP_DIR/.env
  sudo systemctl restart patterndesk
"

say "Health"
# The port is closed to the network on a scanner-only box, so ask from inside.
ssh "$TARGET" "
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 http://127.0.0.1:$PORT/health; then echo; exit 0; fi
    sleep 2
  done
  echo
  echo '  /health did not answer. Last 40 log lines:'
  echo
  sudo journalctl -u patterndesk -n 40 --no-pager
  exit 1
"

say "Deployed"
printf '   journalctl -u patterndesk -f   # follow the log\n\n'

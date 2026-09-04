#!/usr/bin/env bash
#
# Provisions a fresh Oracle Cloud Always Free VM to run the PatternDesk backend.
# Run it ON THE VM, once, before the first deploy:
#
#   sudo bash setup.sh                  # loopback only — nothing reachable from outside
#   sudo EXPOSE_PORT=1 bash setup.sh    # also open the port in the host firewall
#   sudo EXPOSE_PORT=0 bash setup.sh    # close it again
#
# Idempotent. Re-run it after an OS upgrade, or to change EXPOSE_PORT.
#
# It does not start the service: there is no .env yet, and config.js would
# refuse to start anyway. Deploy the code, write .env, then start.

set -euo pipefail

APP_USER=${APP_USER:-patterndesk}
APP_DIR=${APP_DIR:-/opt/patterndesk/server}
NODE_MAJOR=${NODE_MAJOR:-22}
PORT=${PORT:-3000}
EXPOSE_PORT=${EXPOSE_PORT:-0}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UNIT_SRC="$HERE/patterndesk.service"
UNIT_DST=/etc/systemd/system/patterndesk.service

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mfailed:\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo."
[ -f "$UNIT_SRC" ] || die "patterndesk.service not found next to this script ($UNIT_SRC)."

# ── Distro ────────────────────────────────────────────────────────────
# OCI offers Oracle Linux (the default image) and Ubuntu. They differ in
# package manager and, more importantly, in how the host firewall is managed.
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *ubuntu*|*debian*) FAMILY=debian ;;
  *ol*|*rhel*|*fedora*) FAMILY=rhel ;;
  *) die "unrecognised distro '${ID:-?}'. Expected Oracle Linux or Ubuntu." ;;
esac
say "Host"
info "distro    ${PRETTY_NAME:-$ID}  ($FAMILY)"
info "arch      $(uname -m)"
info "memory    $(awk '/MemTotal/ {printf "%d MB", $2/1024}' /proc/meminfo)"

# ── Swap ──────────────────────────────────────────────────────────────
# The 1 GB E2.1.Micro shape runs out of memory during `npm ci` — ccxt is a
# large dependency tree. 2 GB of swap makes the install survive. The A1 shape
# has enough RAM that this is skipped.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_KB=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
if [ "$MEM_MB" -lt 2048 ] && [ "$SWAP_KB" -eq 0 ]; then
  say "Swap"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  info "2 GB swapfile active (this shape has only ${MEM_MB} MB of RAM)"
fi

# ── Node ──────────────────────────────────────────────────────────────
# The distro packages are years behind; package.json needs >= 20. NodeSource
# publishes arm64 as well as x86_64, so this works on both free shapes.
say "Node"
have_node_major=0
if command -v node >/dev/null 2>&1; then
  have_node_major=$(node -p 'process.versions.node.split(".")[0]')
fi
if [ "$have_node_major" -ge 20 ]; then
  info "already installed: $(node -v)"
else
  info "installing Node ${NODE_MAJOR}.x from NodeSource..."
  if [ "$FAMILY" = debian ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    dnf install -y -q curl ca-certificates >/dev/null
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  fi
  info "installed: $(node -v)"
fi

# ── Clock ─────────────────────────────────────────────────────────────
# Bybit rejects any signed request whose timestamp is outside RECV_WINDOW_MS.
# A drifting clock shows up as "invalid signature", which sends you hunting
# through your API keys for a problem that is not there.
say "Clock"
if systemctl is-active --quiet chronyd; then
  info "chronyd active — $(chronyc tracking 2>/dev/null | awk -F': *' '/System time/ {print $2}')"
elif systemctl is-active --quiet systemd-timesyncd; then
  info "systemd-timesyncd active"
elif command -v chronyd >/dev/null 2>&1; then
  systemctl enable --now chronyd
  info "chronyd enabled"
else
  info "WARNING: no time sync daemon found. Install chrony before going live."
fi

# ── Service account ───────────────────────────────────────────────────
say "Service account"
if id "$APP_USER" >/dev/null 2>&1; then
  info "user $APP_USER already exists"
else
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" \
          --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
    || useradd --system --create-home --home-dir "/var/lib/$APP_USER" \
               --shell /sbin/nologin "$APP_USER"
  info "created system user $APP_USER (no login shell)"
fi

install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$(dirname "$APP_DIR")" "$APP_DIR"
info "app directory $APP_DIR"

# If a .env is already there from an earlier deploy, make sure it is not
# world-readable. The keys in it can move money.
if [ -f "$APP_DIR/.env" ]; then
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env permissions tightened to 600"
fi

# ── Firewall ──────────────────────────────────────────────────────────
# Two independent layers block traffic on OCI, and people usually forget the
# second one. This handles the host layer; the VCN security list (or a network
# security group) is a separate change in the Console — see README.
#
# Scanner-only deployments need neither: the backend talks out to the
# exchange and nothing ever needs to talk in.
say "Firewall (host layer)"
if [ "$EXPOSE_PORT" = "1" ]; then
  if [ "$FAMILY" = rhel ] || systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    info "firewalld: opened ${PORT}/tcp"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "${PORT}/tcp" >/dev/null
    info "ufw: opened ${PORT}/tcp"
  else
    # OCI's Ubuntu images ship a preloaded iptables ruleset ending in REJECT,
    # with no ufw. Insert at the top so the position of the REJECT rule does
    # not matter.
    if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
      iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
    fi
    command -v netfilter-persistent >/dev/null 2>&1 \
      && netfilter-persistent save >/dev/null \
      || info "WARNING: could not persist the rule; it will vanish on reboot."
    info "iptables: opened ${PORT}/tcp"
  fi
  info "REMINDER: also add an ingress rule to the VCN security list in the Console."
else
  if [ "$FAMILY" = rhel ] || systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --remove-port="${PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true
  else
    while iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; do
      iptables -D INPUT -p tcp --dport "$PORT" -j ACCEPT
    done
    command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null || true
  fi
  info "port $PORT closed to the network (EXPOSE_PORT=0)"
  info "the backend will be reachable only from the VM itself"
fi

# ── systemd unit ──────────────────────────────────────────────────────
say "systemd"
install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable patterndesk >/dev/null 2>&1
info "unit installed and enabled at boot (not started — no .env yet)"

# Keep the journal from eating the 47 GB boot volume over a year of logs.
if [ ! -f /etc/systemd/journald.conf.d/patterndesk.conf ]; then
  install -d /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=200M\n' >/etc/systemd/journald.conf.d/patterndesk.conf
  systemctl restart systemd-journald
  info "journal capped at 200 MB"
fi

say "Done"
cat <<EOF
   Next, from your own machine:

     bash deploy.sh <user>@<vm-public-ip>

   Then on the VM, write the credentials and start it:

     sudo -u $APP_USER -H cp $APP_DIR/.env.example $APP_DIR/.env
     sudo -u $APP_USER -H nano $APP_DIR/.env     # AUTH_TOKEN, keys, USE_TESTNET=true, DRY_RUN=true
     sudo chmod 600 $APP_DIR/.env
     sudo systemctl start patterndesk
     journalctl -u patterndesk -f

EOF

#!/bin/bash
#
# Iotistica Agent — Full Cleanup
#
# Removes all traces of a previous installation so a fresh dpkg -i starts clean.
# Safe to run multiple times; skips steps that are already done.
#
# Usage:
#   sudo bash cleanup.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
skip() { echo -e "  ${YELLOW}–${NC} $* (not found)"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Run as root: sudo bash $0${NC}"
    exit 1
fi

echo ""
echo "Iotistica Agent — Full Cleanup"
echo "================================"
echo ""

# ── 1. Stop services ─────────────────────────────────────────────────────────

echo "Stopping services..."
for svc in iotistica-agent iotistica-setup iotistica-mqtt-reload.path iotistica-mqtt-reload; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        systemctl stop "$svc" && ok "stopped $svc"
    else
        skip "$svc"
    fi
done

# ── 2. Remove dpkg package (purge removes opt/lib/log/etc dirs via postrm) ──

echo ""
echo "Removing package..."
if dpkg -l iotistica-agent 2>/dev/null | grep -q '^ii'; then
    apt-get purge -y iotistica-agent
    ok "purged iotistica-agent"
else
    skip "iotistica-agent not installed via dpkg"
    # Still remove dirs in case of a manual/partial install
    rm -rf /opt/iotistic/agent
    rm -rf /var/lib/iotistic
    rm -rf /var/log/iotistic
    rm -rf /etc/iotistic
fi

# ── 3. Leftover systemd units (written by postinst, not tracked by dpkg) ────

echo ""
echo "Removing systemd units..."
for unit in \
    /lib/systemd/system/iotistica-agent.service \
    /etc/systemd/system/iotistica-setup.service \
    /etc/systemd/system/iotistica-mqtt-reload.service \
    /etc/systemd/system/iotistica-mqtt-reload.path
do
    if [ -f "$unit" ]; then
        systemctl disable "$(basename "$unit")" 2>/dev/null || true
        rm -f "$unit"
        ok "removed $unit"
    else
        skip "$unit"
    fi
done
systemctl daemon-reload
ok "systemd daemon reloaded"

# ── 4. Leftover scripts and flags ────────────────────────────────────────────

echo ""
echo "Removing scripts and flags..."
for f in \
    /usr/local/sbin/iotistica-setup.sh \
    /usr/local/bin/iotistica-mqtt-reload.sh \
    /etc/sudoers.d/iotistica-mqtt-reload
do
    if [ -e "$f" ]; then
        rm -f "$f" && ok "removed $f"
    else
        skip "$f"
    fi
done

# ── 5. Mosquitto — remove iotistica config so fresh install sets it up clean ─

echo ""
echo "Resetting Mosquitto config..."
for f in \
    /etc/mosquitto/conf.d/iotistica.conf \
    /etc/mosquitto/passwd \
    /etc/mosquitto/acl
do
    if [ -e "$f" ]; then
        rm -f "$f" && ok "removed $f"
    else
        skip "$f"
    fi
done

if systemctl is-active --quiet mosquitto 2>/dev/null; then
    systemctl restart mosquitto && ok "mosquitto restarted"
else
    warn "mosquitto is not running — start it manually if needed"
fi

# ── 6. iotistic user ─────────────────────────────────────────────────────────

echo ""
echo "Removing system user..."
if id -u iotistic > /dev/null 2>&1; then
    userdel iotistic 2>/dev/null && ok "user iotistic removed"
else
    skip "user iotistic"
fi

# ── 7. Verify ────────────────────────────────────────────────────────────────

echo ""
echo "Verifying..."
LEFTOVER=0
for path in /opt/iotistic/agent /var/lib/iotistic /etc/iotistic; do
    [ -e "$path" ] && warn "still exists: $path" && LEFTOVER=1
done
for svc in iotistica-agent iotistica-setup; do
    systemctl is-active --quiet "$svc" 2>/dev/null && warn "$svc still active" && LEFTOVER=1
done

echo ""
if [ "$LEFTOVER" = "0" ]; then
    echo -e "${GREEN}Clean — ready for a fresh install.${NC}"
    echo ""
    echo "  sudo dpkg -i iotistica-agent_<version>_arm64.deb"
else
    echo -e "${YELLOW}Some items remain — check warnings above.${NC}"
fi
echo ""

#!/usr/bin/env bash
# Starts cancore-botd through the unit `cancore-bot install` writes, under a real systemd, and checks
# that it stays up with its sockets in place. Unit tests read the rendered text; only systemd applies
# the sandbox (SystemCallFilter, ProtectSystem …), so a unit that kills the daemon passes them.
# Runs as root inside a disposable container whose PID 1 is systemd; skips otherwise.
#   docker run -d --name sd --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
#     -v "$PWD":/src:ro <image with node 22 + systemd> /sbin/init
#   docker exec sd bash /src/packages/botd/test/systemd/unit-start.sh
set -euo pipefail

if [[ -n "${CANCORE_SYSTEMD_TESTS:-}" && ( $EUID -ne 0 || "$(ps -p 1 -o comm=)" != systemd ) ]]; then
  echo "CANCORE_SYSTEMD_TESTS is set but this is not root under systemd"
  exit 1
fi
if [[ $EUID -ne 0 || "$(ps -p 1 -o comm=)" != systemd || ! ( -f /.dockerenv || -f /run/.containerenv || -n "${CANCORE_SYSTEMD_TESTS:-}" ) ]]; then
  echo "skip: test:systemd needs root in a disposable container whose PID 1 is systemd (or CANCORE_SYSTEMD_TESTS=1)"
  exit 0
fi

SRC=$(cd "$(dirname "$0")/../../../.." && pwd)
# Not /tmp: in a container it is often a noexec tmpfs, and the build runs binaries from node_modules.
BUILD=$(mktemp -d /var/tmp/botd-systemd.XXXXXX)
fails=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if "${@:2}" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }

# The install recipe of packages/botd/README.md, from a copy: the checkout is mounted read-only, and
# npm ci and the build write into the tree.
tar -C "$SRC" --exclude=./node_modules --exclude='./packages/*/node_modules' --exclude='./packages/*/dist' -cf - . | tar -C "$BUILD" -xf -
cd "$BUILD"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
mkdir packs
npm pack --silent --pack-destination packs \
  -w @cancore/contracts -w @cancore/wallet -w @cancore/client \
  -w @cancore/trader -w @cancore/botd -w @cancore/bot-mcp >/dev/null
npm install --ignore-scripts --no-audit --no-fund --prefix /opt/cancore-bot ./packs/*.tgz >/dev/null
ln -sf /opt/cancore-bot/node_modules/.bin/cancore-* /usr/local/bin/

id botagent >/dev/null 2>&1 || useradd --create-home botagent
cancore-bot install --human botagent >/dev/null
systemctl start cancore-botd

# Restart=on-failure hides a crash loop behind "activating": wait past systemd's start burst.
for _ in $(seq 30); do [[ -S /run/cancore-bot/bot.sock && -S /run/cancore-bot/owner.sock ]] && break; sleep 0.5; done
sleep 3

check "the unit is active" test "$(systemctl is-active cancore-botd)" = active
check "the daemon has not restarted" test "$(systemctl show -p NRestarts --value cancore-botd)" = 0
# systemd drops a sandbox setting it cannot apply; a daemon without seccomp would pass the checks above
# on a unit that lacks @chown.
check "the daemon runs under a seccomp filter" grep -Eq '^Seccomp:[[:space:]]+2$' "/proc/$(systemctl show -p MainPID --value cancore-botd)/status"
check "agent socket is group cancore-bot-clients, mode 660" test "$(stat -c '%G %a' /run/cancore-bot/bot.sock)" = "cancore-bot-clients 660"
check "owner socket is cancore-bot only, mode 600" test "$(stat -c '%U %a' /run/cancore-bot/owner.sock)" = "cancore-bot 600"
check "the owner CLI reads status over owner.sock" bash -c "runuser -u cancore-bot -- cancore-bot status | grep -q '\"locked\": true'"

if ((fails)); then
  systemctl status cancore-botd --no-pager || true
  journalctl -u cancore-botd --no-pager -n 20 || true
  echo "$fails check(s) failed"
  exit 1
fi
echo "all systemd checks passed"

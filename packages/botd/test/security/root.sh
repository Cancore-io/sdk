#!/usr/bin/env bash
# OS-level isolation checks for cancore-botd that need root: separate users, the clients group,
# socket and state-dir permissions, process isolation between users, and the systemd unit.
# Opt-in: runs only as root inside a disposable container (it creates users and groups), skips otherwise.
#   docker run --rm -v "$PWD":/sdk -w /sdk node:22 bash -c 'npm ci && npm run build && npm run test:security:root'
set -euo pipefail

# CI sets CANCORE_ROOT_TESTS: there a skip would be a false green, so not being root fails.
if [[ -n "${CANCORE_ROOT_TESTS:-}" && $EUID -ne 0 ]]; then
  echo "CANCORE_ROOT_TESTS is set but this is not root"
  exit 1
fi
if [[ $EUID -ne 0 || ! ( -f /.dockerenv || -f /run/.containerenv || -n "${CANCORE_ROOT_TESTS:-}" ) ]]; then
  echo "skip: test:security:root needs root inside a disposable container (or CANCORE_ROOT_TESTS=1)"
  exit 0
fi

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
DIST="$ROOT/packages/botd/dist"
[[ -f "$DIST/daemon.js" ]] || { echo "build first: npm run build"; exit 1; }
NODE=$(command -v node)
W=$(mktemp -d /tmp/cbsec.XXXXXX)
chmod 0755 "$W"
fails=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
expect_ok() { if "${@:2}" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }
expect_no() { if "${@:2}" >/dev/null 2>&1; then fail "$1"; else pass "$1"; fi; }

getent group cancore-bot-clients >/dev/null || groupadd --system cancore-bot-clients
id cancore-bot >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin -G cancore-bot-clients cancore-bot
id botagent >/dev/null 2>&1 || useradd --create-home -G cancore-bot-clients botagent
id outsider >/dev/null 2>&1 || useradd --create-home outsider

install -d -m 0700 -o cancore-bot -g cancore-bot "$W/state"
install -d -m 0711 -o cancore-bot -g cancore-bot "$W/run"
cat >"$W/config.json" <<JSON
{"stateDir":"$W/state","agentSocket":"$W/run/bot.sock","ownerSocket":"$W/run/owner.sock","baseUrl":"http://127.0.0.1:9","network":"devnet"}
JSON
chmod 0644 "$W/config.json"
as() { local u=$1; shift; runuser -u "$u" -- "$@"; }
rpc() { # user socket method [params-json]
  as "$1" "$NODE" --input-type=module -e "
    import { connect } from '$DIST/ipc/client.js';
    const c = await connect('$2');
    try { console.log(JSON.stringify(await c.call('$3', ${4:-{\}}))); } catch (e) { console.log(JSON.stringify(e.error ?? String(e))); process.exitCode = 2; } finally { c.close(); }"
}

as cancore-bot "$NODE" --input-type=module -e "
  import { createKeystore } from '$DIST/index.js';
  await createKeystore('$W/state/keystore.json').init('legal winner thank year wave sausage worth useful legal winner thank yellow', 'root-test-pass');"

as cancore-bot "$NODE" "$DIST/daemon.js" --config "$W/config.json" 2>"$W/daemon.err" &
for _ in $(seq 50); do [[ -S "$W/run/bot.sock" && -S "$W/run/owner.sock" ]] && break; sleep 0.1; done
PID=
for p in /proc/[0-9]*; do
  [[ $(stat -c %U "$p" 2>/dev/null) == cancore-bot ]] && tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q "daemon.js" && PID=${p#/proc/} && break
done
[[ -n $PID ]] || { cat "$W/daemon.err"; echo "daemon did not start"; exit 1; }

expect_ok "agent socket is group cancore-bot-clients, mode 660" test "$(stat -c '%G %a' "$W/run/bot.sock")" = "cancore-bot-clients 660"
expect_ok "owner socket is cancore-bot only, mode 600" test "$(stat -c '%U %a' "$W/run/owner.sock")" = "cancore-bot 600"
expect_ok "clients-group member reads status on the agent socket" rpc botagent "$W/run/bot.sock" status
expect_no "clients-group member cannot unlock on the agent socket" rpc botagent "$W/run/bot.sock" unlock '{"passphrase":"root-test-pass"}'
expect_no "clients-group member cannot connect to the owner socket" rpc botagent "$W/run/owner.sock" status
expect_no "outsider cannot connect to the agent socket" rpc outsider "$W/run/bot.sock" status
expect_no "agent cannot list the state dir" as botagent ls "$W/state"
expect_no "agent cannot read the keystore" as botagent cat "$W/state/keystore.json"
expect_no "agent cannot replace the agent socket" as botagent ln -sf /tmp/x "$W/run/bot.sock"
expect_no "agent cannot read the daemon's environment" as botagent cat "/proc/$PID/environ"
expect_no "agent cannot read the daemon's memory" as botagent dd if="/proc/$PID/mem" bs=1 count=1 skip=4096
expect_no "agent cannot signal the daemon" as botagent kill -0 "$PID"
expect_ok "owner (daemon user) can unlock on the owner socket" rpc cancore-bot "$W/run/owner.sock" unlock '{"passphrase":"root-test-pass"}'
expect_ok "audit log is 0600 cancore-bot" test "$(stat -c '%U %a' "$W/state/audit.jsonl")" = "cancore-bot 600"
if grep -rq "root-test-pass" "$W/state" "$W/daemon.err"; then fail "passphrase absent from state dir and daemon stderr"; else pass "passphrase absent from state dir and daemon stderr"; fi

# The daemon refuses to start as anyone but its configured user.
expect_no "daemon refuses to run as another user" as botagent timeout 5 "$NODE" "$DIST/daemon.js" --config "$W/config.json"

# systemd hardening (ProtectSystem, NoNewPrivileges, SystemCallFilter …) needs a systemd host, not a container:
# there, after `cancore-bot install`, run `systemd-analyze security cancore-botd`.

kill "$PID" 2>/dev/null || true
wait 2>/dev/null || true
rm -rf "$W"
echo "root checks: $fails failed"
exit $((fails > 0))

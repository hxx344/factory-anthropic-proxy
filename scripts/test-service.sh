#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { printf 'Run the systemd smoke test as root.\n' >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE_BINARY:-$(command -v node)}"
SERVICE="factory-proxy-ci-$$"
PREFIX="/opt/$SERVICE"
CONFIG_DIR="/etc/$SERVICE"
UNIT="/etc/systemd/system/$SERVICE.service"
TEMP="$(mktemp -d /tmp/factory-proxy-service-test.XXXXXXXX)"
USER_CREATED=0
RESOURCES_OWNED=0
cleanup() {
  local status=$?
  trap - ERR
  if (( RESOURCES_OWNED )); then
    if (( status != 0 )); then journalctl -u "$SERVICE" -n 80 --no-pager >&2 || true; fi
    systemctl stop "$SERVICE" 2>/dev/null || true
    systemctl disable "$SERVICE" 2>/dev/null || true
    rm -f -- "$UNIT"
    systemctl daemon-reload || true
    systemctl reset-failed "$SERVICE" 2>/dev/null || true
    if (( USER_CREATED )) || id "$SERVICE" >/dev/null 2>&1; then
      userdel "$SERVICE" 2>/dev/null || true
      if getent group "$SERVICE" >/dev/null 2>&1; then groupdel "$SERVICE" 2>/dev/null || true; fi
    fi
    for path in "$PREFIX" "$CONFIG_DIR" "/var/lib/$SERVICE"; do
      case "$path" in /opt/factory-proxy-ci-[0-9]*|/etc/factory-proxy-ci-[0-9]*|/var/lib/factory-proxy-ci-[0-9]*) rm -rf -- "$path" ;; esac
    done
  fi
  case "$TEMP" in /tmp/factory-proxy-service-test.*) rm -rf -- "$TEMP" ;; esac
}
trap cleanup EXIT
if [[ -e "$PREFIX" || -e "$CONFIG_DIR" || -e "$UNIT" ]] || id "$SERVICE" >/dev/null 2>&1 || getent group "$SERVICE" >/dev/null 2>&1; then
  printf 'The systemd test fixture already exists; refusing to overwrite it.\n' >&2; exit 1
fi
RESOURCES_OWNED=1
export FACTORY_API_KEY='systemd-ci-factory-key'
export PROXY_API_KEY='systemd-ci-proxy-key-01234567890123456789'
install -d -m 700 "$CONFIG_DIR"
PROXY_CONFIG="$CONFIG_DIR/proxy.config.json" "$NODE" "$ROOT/bin/proxy.mjs" init >/dev/null
"$NODE" --input-type=module - "$CONFIG_DIR/proxy.config.json" <<'NODE'
import fs from 'node:fs';
import net from 'node:net';
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
config.host = '127.0.0.1';
config.port = server.address().port;
await new Promise((resolve) => server.close(resolve));
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
install_proxy() {
  bash "$ROOT/scripts/install.sh" --source "$1" --prefix "$PREFIX" --config-dir "$CONFIG_DIR" --node "$NODE" --service-name "$SERVICE"
}
health() {
  "$NODE" --input-type=module - "$CONFIG_DIR/proxy.config.json" <<'NODE'
import fs from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (let attempt = 0; attempt < 40; attempt++) {
  const healthy = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
  if (healthy) process.exit(0);
  await wait(100);
}
throw new Error('The installed service did not become healthy.');
NODE
}
install_proxy "$ROOT" > "$TEMP/first.log"
USER_CREATED=1
if command -v systemd-analyze >/dev/null; then
  grep -q 'Validating staged systemd unit.' "$TEMP/first.log"
  systemd-analyze --man=no verify "$UNIT"
fi
systemctl is-active --quiet "$SERVICE"
systemctl is-enabled --quiet "$SERVICE"
health
test "$(systemctl show "$SERVICE" --property=User --value)" = "$SERVICE"
test "$(systemctl show "$SERVICE" --property=WorkingDirectory --value)" = "$PREFIX/current"
systemctl show "$SERVICE" --property=EnvironmentFiles --value | grep -Fq -- "$CONFIG_DIR/environment"
test "$(stat -c '%U:%G' "$CONFIG_DIR/proxy.config.json")" = "$SERVICE:$SERVICE"
test "$(stat -c '%a' "$CONFIG_DIR/proxy.config.json")" = 600
test "$(stat -c '%a' "$CONFIG_DIR/environment")" = 600
FIRST_CURRENT="$(readlink -f "$PREFIX/current")"
FIRST_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
test "$FIRST_PID" -gt 0
CONFIG_SHA="$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')"
ENVIRONMENT_SHA="$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')"
install_proxy "$ROOT" > "$TEMP/repeat.log"
test "$(systemctl show "$SERVICE" --property=MainPID --value)" = "$FIRST_PID"
grep -q 'Unchanged: skipped downloads, copies, validation and restart.' "$TEMP/repeat.log"

# An edited configuration restarts the service without replacing the same source.
"$NODE" --input-type=module - "$CONFIG_DIR/proxy.config.json" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.timeoutMs += 1000;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE
CONFIG_SHA="$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')"
install_proxy "$ROOT" > "$TEMP/configuration.log"
CONFIG_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
test "$CONFIG_PID" -gt 0
test "$CONFIG_PID" != "$FIRST_PID"
test "$(readlink -f "$PREFIX/current")" = "$FIRST_CURRENT"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$CONFIG_SHA"
health

mkdir "$TEMP/upgrade"
for entry in package.json bin src scripts docs README.md LICENSE start.cmd proxy.config.example.json .env.example; do
  [[ ! -e "$ROOT/$entry" ]] || cp -R -- "$ROOT/$entry" "$TEMP/upgrade/"
done
printf '\nSystemd upgrade fixture.\n' >> "$TEMP/upgrade/README.md"
install_proxy "$TEMP/upgrade" > "$TEMP/upgrade.log"
UPGRADED_CURRENT="$(readlink -f "$PREFIX/current")"
UPGRADED_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
test "$UPGRADED_CURRENT" != "$FIRST_CURRENT"
test "$(readlink -f "$PREFIX/previous")" = "$FIRST_CURRENT"
test "$UPGRADED_PID" -gt 0
test "$UPGRADED_PID" != "$CONFIG_PID"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$CONFIG_SHA"
test "$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')" = "$ENVIRONMENT_SHA"
health

# This remains valid JavaScript and passes staging checks, then fails on service activation.
printf '\nthrow new Error("Intentional CI activation failure");\n' >> "$TEMP/upgrade/bin/proxy.mjs"
if FACTORY_API_KEY='systemd-ci-rejected-upgrade-key' install_proxy "$TEMP/upgrade" > "$TEMP/failure.log" 2>&1; then
  cat "$TEMP/failure.log" >&2
  printf 'The intentionally failing service was unexpectedly activated.\n' >&2; exit 1
fi
grep -q 'restoring the previous release' "$TEMP/failure.log"
test "$(readlink -f "$PREFIX/current")" = "$UPGRADED_CURRENT"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$CONFIG_SHA"
test "$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')" = "$ENVIRONMENT_SHA"
systemctl is-active --quiet "$SERVICE"
health
printf 'Systemd checks passed: dedicated-user startup, unchanged PID, configuration/source restart, failed-activation rollback and retained health.\n'

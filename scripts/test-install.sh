#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-anthropic-proxy-test.XXXXXXXX")"
PID=''
cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  case "$TEMP" in "${TMPDIR:-/tmp}"/factory-anthropic-proxy-test.*) [[ ! -d "$TEMP" ]] || rm -rf -- "$TEMP" ;; esac
}
trap cleanup EXIT
PREFIX="$TEMP/installation"
CONFIG_DIR="$TEMP/configuration"
install_proxy() {
  bash "$ROOT/scripts/install.sh" --source "$1" --prefix "$PREFIX" --config-dir "$CONFIG_DIR" --node "$NODE" --no-service
}
FACTORY_API_KEY='installer-test-key' install_proxy "$ROOT" > "$TEMP/first.log"
test -L "$PREFIX/current"
test -f "$CONFIG_DIR/proxy.config.json"
test "$(stat -c '%a' "$CONFIG_DIR/environment")" = 600
test "$(stat -c '%a' "$CONFIG_DIR/proxy.config.json")" = 600
FIRST_CURRENT="$(readlink -f "$PREFIX/current")"
FIRST_CONFIG_SHA="$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')"
FIRST_ENV_SHA="$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')"
FIRST_MTIME="$(stat -c '%Y' "$FIRST_CURRENT/.validated-runtime")"
chmod 755 "$CONFIG_DIR"
chmod 644 "$CONFIG_DIR/proxy.config.json"
FACTORY_API_KEY='installer-test-key' install_proxy "$ROOT" > "$TEMP/repeat.log"
test "$(stat -c '%a' "$CONFIG_DIR")" = 700
test "$(stat -c '%a' "$CONFIG_DIR/proxy.config.json")" = 600
test "$(readlink -f "$PREFIX/current")" = "$FIRST_CURRENT"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$FIRST_CONFIG_SHA"
test "$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')" = "$FIRST_ENV_SHA"
test "$(stat -c '%Y' "$FIRST_CURRENT/.validated-runtime")" = "$FIRST_MTIME"
grep -q 'Unchanged: skipped downloads, copies, validation and restart.' "$TEMP/repeat.log"

mkdir "$TEMP/upgrade"
for entry in package.json bin src scripts docs README.md LICENSE start.cmd proxy.config.example.json .env.example; do
  [[ ! -e "$ROOT/$entry" ]] || cp -R -- "$ROOT/$entry" "$TEMP/upgrade/"
done
printf '\nInstaller upgrade fixture.\n' >> "$TEMP/upgrade/README.md"
install_proxy "$TEMP/upgrade" > "$TEMP/upgrade.log"
UPGRADE_CURRENT="$(readlink -f "$PREFIX/current")"
test "$UPGRADE_CURRENT" != "$FIRST_CURRENT"
test "$(readlink -f "$PREFIX/previous")" = "$FIRST_CURRENT"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$FIRST_CONFIG_SHA"
test "$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')" = "$FIRST_ENV_SHA"

# Change source syntax so validation fails before the active release is switched.
printf '\nexport const = ;\n' >> "$TEMP/upgrade/bin/proxy.mjs"
if install_proxy "$TEMP/upgrade" > "$TEMP/broken.log" 2>&1; then
  printf 'Broken package was unexpectedly installed.\n' >&2; exit 1
fi
test "$(readlink -f "$PREFIX/current")" = "$UPGRADE_CURRENT"
test "$(sha256sum "$CONFIG_DIR/proxy.config.json" | awk '{print $1}')" = "$FIRST_CONFIG_SHA"
test "$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')" = "$FIRST_ENV_SHA"

# A rejected archive must not write outside the extraction directory.
mkdir -p "$TEMP/links/package"
ln -s /tmp "$TEMP/links/package/outside"
tar -czf "$TEMP/linked.tgz" -C "$TEMP/links" package
if install_proxy "$TEMP/linked.tgz" > "$TEMP/linked.log" 2>&1; then
  printf 'Archive with a symlink was unexpectedly accepted.\n' >&2; exit 1
fi
test "$(readlink -f "$PREFIX/current")" = "$UPGRADE_CURRENT"

# Reserve a free port and use the retained release for an actual HTTP smoke check.
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
PROXY_CONFIG="$CONFIG_DIR/proxy.config.json" FACTORY_API_KEY='installer-test-key' "$NODE" "$PREFIX/current/bin/proxy.mjs" serve > "$TEMP/server.log" 2>&1 &
PID=$!
if ! "$NODE" --input-type=module - "$CONFIG_DIR/proxy.config.json" <<'NODE'
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (let attempt = 0; attempt < 40; attempt++) {
  const healthy = await new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: config.port, path: '/healthz', timeout: 1000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
  if (healthy) process.exit(0);
  await wait(100);
}
throw new Error('Retained release did not become healthy.');
NODE
then cat "$TEMP/server.log" >&2; exit 1; fi
kill "$PID"
wait "$PID" || true
PID=''
printf 'Installer checks passed: first install, unchanged rerun, configuration-preserving upgrade, rejected broken source/archive, retained-release HTTP health.\n'

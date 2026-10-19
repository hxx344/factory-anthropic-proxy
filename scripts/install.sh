#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPOSITORY='hxx344/factory-anthropic-proxy'
NODE_VERSION='24.15.0'
PREFIX='/opt/factory-anthropic-proxy'
CONFIG_DIR='/etc/factory-anthropic-proxy'
SOURCE=''
VERSION='latest'
SERVICE=1
NODE=''
TEMP=''
SERVICE_NAME='factory-anthropic-proxy'
SERVICE_USER='factory-anthropic-proxy'
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"
SWITCHED=0
OLD_CURRENT=''
ENV_CHANGED=0
UNIT_CHANGED=0
CONFIG_CREATED=0
CONFIG_CHANGED=0
SOURCE_CHANGED=0
RUNTIME_CHANGED=0
VALIDATED=0
ACTIVATION_ATTEMPTED=0

log() { printf '%s\n' "$*"; }
fail() { printf 'Installation failed: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: bash install.sh [--source DIR|PACKAGE.tgz] [--version latest|vX.Y.Z]
                       [--prefix ABSOLUTE_PATH] [--config-dir ABSOLUTE_PATH]
                       [--node ABSOLUTE_PATH] [--no-service] [--service-name NAME]
Installs or upgrades the proxy, retaining its configuration and previous release.
With no --source, a checkout uses its own source; a downloaded installer uses GitHub Releases.
FACTORY_API_KEY and PROXY_API_KEY update only the corresponding environment entries when explicitly supplied.
USAGE
}
while (( $# )); do
  case "$1" in
    --source|--package) (( $# >= 2 )) || fail "$1 requires a value"; SOURCE="$2"; shift 2 ;;
    --version) (( $# >= 2 )) || fail "$1 requires a value"; VERSION="$2"; shift 2 ;;
    --prefix) (( $# >= 2 )) || fail "$1 requires a value"; PREFIX="$2"; shift 2 ;;
    --config-dir) (( $# >= 2 )) || fail "$1 requires a value"; CONFIG_DIR="$2"; shift 2 ;;
    --node) (( $# >= 2 )) || fail "$1 requires a value"; NODE="$2"; shift 2 ;;
    --service-name) (( $# >= 2 )) || fail "$1 requires a value"; SERVICE_NAME="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ "$SERVICE_NAME" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || fail 'Service name must contain 1-31 lowercase letters, digits or hyphens and start with a letter.'
SERVICE_USER="$SERVICE_NAME"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"
[[ "$(uname -s)" == Linux ]] || fail 'This installer requires Linux. On Windows, use start.cmd.'
if (( SERVICE )); then
  (( EUID == 0 )) || fail 'Run with sudo for systemd installation, or use --no-service with writable directories.'
  command -v systemctl >/dev/null || fail 'systemd is required; use --no-service to manage the process yourself.'
  systemctl show-environment >/dev/null 2>&1 || fail 'systemd is not running; use --no-service to manage the process yourself.'
fi

dependencies() {
  local missing=0 command_name
  for command_name in curl tar sha256sum mktemp realpath readlink install cmp awk sed; do
    command -v "$command_name" >/dev/null || missing=1
  done
  if (( SERVICE )); then command -v useradd >/dev/null || missing=1; fi
  (( missing )) || return 0
  (( EUID == 0 )) || fail 'Required tools are missing. Install curl, ca-certificates, tar, coreutils and findutils, or rerun with sudo.'
  log 'Installing missing system tools.'
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar coreutils findutils passwd
  elif command -v dnf >/dev/null; then
    dnf install -y curl ca-certificates tar coreutils findutils shadow-utils
  elif command -v yum >/dev/null; then
    yum install -y curl ca-certificates tar coreutils findutils shadow-utils
  elif command -v apk >/dev/null; then
    apk add --no-cache curl ca-certificates tar coreutils findutils shadow
  else fail 'No supported package manager was found for the missing system tools.'; fi
}
dependencies
safe_path() {
  local value="$1"
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'%'* && "$value" != *'"'* && "$value" != *'\'* ]] || fail 'Install paths must be absolute and must not contain newlines, %, quotes or backslashes.'
  value="$(realpath -m -- "$value")"
  case "$value" in /|/opt|/etc|/usr|/var|/home|/root|/tmp) fail "Refusing broad install path: $value" ;; esac
  printf '%s' "$value"
}
PREFIX="$(safe_path "$PREFIX")"
CONFIG_DIR="$(safe_path "$CONFIG_DIR")"
[[ "$PREFIX" != "$CONFIG_DIR" ]] || fail 'The install and configuration directories must differ.'
[[ ! -e "$PREFIX/current" || -L "$PREFIX/current" ]] || fail 'The current release path must be a symlink.'
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-anthropic-proxy.XXXXXXXX")"
cleanup() {
  case "$TEMP" in "${TMPDIR:-/tmp}"/factory-anthropic-proxy.*) [[ ! -d "$TEMP" ]] || rm -rf -- "$TEMP" ;; esac
}
rollback() {
  local status=$?
  trap - ERR
  if (( SWITCHED )); then
    log 'Activation failed; restoring the previous release.' >&2
    if [[ -n "$OLD_CURRENT" ]]; then
      ln -s -- "$OLD_CURRENT" "$PREFIX/.rollback-$$"
      mv -Tf -- "$PREFIX/.rollback-$$" "$PREFIX/current"
    else rm -f -- "$PREFIX/current"; fi
  fi
  if (( ENV_CHANGED )); then
    if [[ -f "$TEMP/environment.before" ]]; then install -m 600 "$TEMP/environment.before" "$CONFIG_DIR/environment";
    else rm -f -- "$CONFIG_DIR/environment"; fi
  fi
  if (( UNIT_CHANGED )); then
    if [[ -f "$TEMP/unit.before" ]]; then install -m 644 "$TEMP/unit.before" "$UNIT_PATH";
    else rm -f -- "$UNIT_PATH"; fi
    systemctl daemon-reload || true
  fi
  if (( SERVICE && ACTIVATION_ATTEMPTED )); then
    if [[ -n "$OLD_CURRENT" ]]; then systemctl restart "$SERVICE_NAME" || true;
    else systemctl stop "$SERVICE_NAME" || true; fi
  fi
  printf 'Installation failed; existing configuration and release files were retained.\n' >&2
  exit "$status"
}
trap cleanup EXIT
trap rollback ERR
install -d -m 755 "$PREFIX" "$PREFIX/releases"
if [[ -L "$PREFIX/current" ]]; then OLD_CURRENT="$(readlink -f -- "$PREFIX/current")"; fi

if [[ -z "$SOURCE" && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$SCRIPT_ROOT/package.json" && -f "$SCRIPT_ROOT/bin/proxy.mjs" ]]; then SOURCE="$SCRIPT_ROOT"; fi
fi
ARCHIVE=''
REMOTE_BASE=''
ARCHIVE_NAME=''
if [[ -n "$SOURCE" && -d "$SOURCE" ]]; then
  SOURCE="$(realpath -- "$SOURCE")"
  [[ -f "$SOURCE/package.json" && -f "$SOURCE/bin/proxy.mjs" ]] || fail 'Source directory is missing package.json or bin/proxy.mjs.'
  ARCHIVE="$TEMP/source.tgz"
  SOURCE_FILES=()
  for name in package.json bin src scripts docs README.md LICENSE start.cmd proxy.config.example.json .env.example; do
    [[ ! -e "$SOURCE/$name" ]] || SOURCE_FILES+=("$name")
  done
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    --exclude='node_modules' --exclude='.local' --exclude='.git' --exclude='proxy.config.json' --exclude='.env' \
    --transform='s,^,package/,' -czf "$ARCHIVE" -C "$SOURCE" "${SOURCE_FILES[@]}"
  SOURCE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
elif [[ -n "$SOURCE" ]]; then
  [[ -f "$SOURCE" ]] || fail "Source package does not exist: $SOURCE"
  ARCHIVE="$(realpath -- "$SOURCE")"
  SOURCE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
else
  [[ "$VERSION" == latest || "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.+-][A-Za-z0-9.-]+)?$ ]] || fail 'Invalid release version.'
  if [[ "$VERSION" == latest ]]; then REMOTE_BASE="https://github.com/$REPOSITORY/releases/latest/download";
  else [[ "$VERSION" == v* ]] || VERSION="v$VERSION"; REMOTE_BASE="https://github.com/$REPOSITORY/releases/download/$VERSION"; fi
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 120 "$REMOTE_BASE/SHA256SUMS" -o "$TEMP/SHA256SUMS"
  mapfile -t MATCHES < <(awk '$2 ~ /^factory-anthropic-proxy-[A-Za-z0-9.+-]+\.tgz$/ {print $1 " " $2}' "$TEMP/SHA256SUMS")
  (( ${#MATCHES[@]} == 1 )) || fail 'The release checksum list must contain exactly one proxy package.'
  read -r SOURCE_SHA ARCHIVE_NAME <<< "${MATCHES[0]}"
  [[ "$SOURCE_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid package checksum in release metadata.'
fi
RELEASE_DIR="$PREFIX/releases/$SOURCE_SHA"
if [[ ! -d "$RELEASE_DIR" ]]; then
  if [[ -z "$ARCHIVE" ]]; then
    ARCHIVE="$TEMP/$ARCHIVE_NAME"
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 300 "$REMOTE_BASE/$ARCHIVE_NAME" -o "$ARCHIVE"
  fi
  [[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$SOURCE_SHA" ]] || fail 'Package checksum mismatch.'
  tar -tzf "$ARCHIVE" > "$TEMP/entries"
  while IFS= read -r entry; do
    [[ "$entry" == package/* && "$entry" != *'\'* && "/$entry/" != *'/../'* && "/$entry/" != *'/./'* ]] || fail "Unsafe archive entry: $entry"
    case "$entry" in package/.env.example) ;; */.env|*/.env.*|*/proxy.config.json|*/node_modules/*|*/.local/*|*/.git/*) fail "Private archive entry: $entry" ;; esac
  done < "$TEMP/entries"
  tar -tvzf "$ARCHIVE" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' || fail 'Archive links and special files are not allowed.'
  install -d -m 755 "$TEMP/extracted"
  tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$TEMP/extracted"
  STAGE="$TEMP/extracted/package"
  [[ -f "$STAGE/package.json" && -f "$STAGE/bin/proxy.mjs" && -f "$STAGE/scripts/check.mjs" ]] || fail 'Package is missing required proxy files.'
else
  STAGE="$RELEASE_DIR"
  log 'Skipped: source download and copy (release already present).'
fi

node_ok() { [[ -n "$1" && -x "$1" ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }
if [[ -n "$NODE" ]]; then
  [[ "$NODE" == /* ]] || fail '--node must be an absolute path.'
  node_ok "$NODE" || fail 'The specified Node.js runtime must be version 22 or later.'
else
  NODE="$(command -v node || true)"
  if (( SERVICE )) && [[ "$NODE" == /root/* || "$NODE" == /home/* ]]; then NODE=''; fi
  if ! node_ok "$NODE"; then
    case "$(uname -m)" in x86_64|amd64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) fail 'Automatic Node.js installation supports Linux x64 and arm64 only.' ;; esac
    RUNTIME_NAME="node-v$NODE_VERSION-linux-$NODE_ARCH"
    RUNTIME_DIR="$PREFIX/.local/runtime/$RUNTIME_NAME"
    NODE="$RUNTIME_DIR/bin/node"
    if ! node_ok "$NODE"; then
      RUNTIME_ARCHIVE="$RUNTIME_NAME.tar.gz"
      NODE_BASE="https://nodejs.org/dist/v$NODE_VERSION"
      curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 120 "$NODE_BASE/SHASUMS256.txt" -o "$TEMP/NODE-SHASUMS256.txt"
      NODE_SHA="$(awk -v filename="$RUNTIME_ARCHIVE" '$2 == filename {print $1}' "$TEMP/NODE-SHASUMS256.txt")"
      [[ "$NODE_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'Official Node.js checksum is missing.'
      curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 300 "$NODE_BASE/$RUNTIME_ARCHIVE" -o "$TEMP/$RUNTIME_ARCHIVE"
      [[ "$(sha256sum "$TEMP/$RUNTIME_ARCHIVE" | awk '{print $1}')" == "$NODE_SHA" ]] || fail 'Node.js checksum mismatch.'
      tar --no-same-owner --no-same-permissions -xzf "$TEMP/$RUNTIME_ARCHIVE" -C "$TEMP"
      node_ok "$TEMP/$RUNTIME_NAME/bin/node" || fail 'Downloaded Node.js runtime failed its version check.'
      install -d -m 755 "$PREFIX/.local" "$PREFIX/.local/runtime"
      chmod -R a+rX "$TEMP/$RUNTIME_NAME"
      if [[ -e "$RUNTIME_DIR" || -L "$RUNTIME_DIR" ]]; then mv -- "$RUNTIME_DIR" "$RUNTIME_DIR.previous-$$"; fi
      mv -- "$TEMP/$RUNTIME_NAME" "$RUNTIME_DIR"
      RUNTIME_CHANGED=1
    fi
  fi
fi
NODE_ID="$NODE $("$NODE" --version)"
if [[ -f "$PREFIX/.install-state" && "$(sed -n 's/^runtime=//p' "$PREFIX/.install-state")" != "$NODE_ID" ]]; then RUNTIME_CHANGED=1; fi
if [[ -f "$STAGE/.validated-runtime" && "$(cat "$STAGE/.validated-runtime")" == "$NODE_ID" ]]; then
  log 'Skipped: source validation (same content and runtime).'
else
  log 'Validating staged source.'
  "$NODE" "$STAGE/scripts/check.mjs"
  "$NODE" --input-type=module - "$STAGE/package.json" <<'NODE'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (pkg.name !== 'factory-anthropic-proxy' || pkg.type !== 'module' || Object.keys(pkg.dependencies ?? {}).length) {
  throw new Error('Expected the zero-dependency factory-anthropic-proxy ESM package.');
}
NODE
  printf '%s\n' "$NODE_ID" > "$STAGE/.validated-runtime"
  VALIDATED=1
fi
if [[ "$STAGE" != "$RELEASE_DIR" ]]; then
  chmod -R a+rX "$STAGE"
  mv -- "$STAGE" "$RELEASE_DIR"
fi

if (( SERVICE )) && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir "/var/lib/$SERVICE_NAME" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
if [[ ! -d "$CONFIG_DIR" ]]; then install -d -m 700 "$CONFIG_DIR"; fi
if [[ "$(stat -c '%a' "$CONFIG_DIR")" != 700 ]]; then chmod 700 "$CONFIG_DIR"; fi
CONFIG="$CONFIG_DIR/proxy.config.json"
if [[ ! -f "$CONFIG" ]]; then
  PROXY_CONFIG="$CONFIG" "$NODE" "$RELEASE_DIR/bin/proxy.mjs" init
  [[ -f "$CONFIG" ]] || fail 'Proxy init did not create its configuration file.'
  chmod 600 "$CONFIG"
  CONFIG_CREATED=1
fi
if [[ "$(stat -c '%a' "$CONFIG")" != 600 ]]; then chmod 600 "$CONFIG"; fi
if (( SERVICE )); then
  if [[ "$(stat -c '%U:%G' "$CONFIG_DIR")" != "$SERVICE_USER:$SERVICE_USER" ]]; then chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"; fi
  if [[ "$(stat -c '%U:%G' "$CONFIG")" != "$SERVICE_USER:$SERVICE_USER" ]]; then chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG"; fi
fi
CONFIG_SHA="$(sha256sum "$CONFIG" | awk '{print $1}')"
if [[ ! -f "$PREFIX/.install-state" || "$(sed -n 's/^config=//p' "$PREFIX/.install-state")" != "$CONFIG_SHA" ]]; then CONFIG_CHANGED=1; fi
if [[ -f "$CONFIG_DIR/environment" ]]; then cp -- "$CONFIG_DIR/environment" "$TEMP/environment.before"; cp -- "$CONFIG_DIR/environment" "$TEMP/environment.next";
else : > "$TEMP/environment.next"; fi
write_environment() {
  local name="$1" value="$2" line replaced=0
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$name must not contain newlines."
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  : > "$TEMP/environment.filtered"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$name="* ]]; then
      if (( ! replaced )); then printf '%s="%s"\n' "$name" "$value" >> "$TEMP/environment.filtered"; replaced=1; fi
    else printf '%s\n' "$line" >> "$TEMP/environment.filtered"; fi
  done < "$TEMP/environment.next"
  if (( ! replaced )); then printf '%s="%s"\n' "$name" "$value" >> "$TEMP/environment.filtered"; fi
  mv -- "$TEMP/environment.filtered" "$TEMP/environment.next"
}
[[ -z "${FACTORY_API_KEY:-}" ]] || write_environment FACTORY_API_KEY "$FACTORY_API_KEY"
[[ -z "${PROXY_API_KEY:-}" ]] || write_environment PROXY_API_KEY "$PROXY_API_KEY"
if [[ ! -f "$CONFIG_DIR/environment" ]] || ! cmp -s "$TEMP/environment.next" "$CONFIG_DIR/environment"; then
  ENV_CHANGED=1
  install -m 600 "$TEMP/environment.next" "$CONFIG_DIR/environment"
fi
ENVIRONMENT_SHA="$(sha256sum "$CONFIG_DIR/environment" | awk '{print $1}')"
if [[ -f "$PREFIX/.install-state" && "$(sed -n 's/^environment=//p' "$PREFIX/.install-state")" != "$ENVIRONMENT_SHA" ]]; then ENV_CHANGED=1; fi

if (( SERVICE )); then
  cat > "$TEMP/unit.next" <<UNIT
[Unit]
Description=Factory Anthropic-compatible local proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory="$PREFIX/current"
Environment="PROXY_CONFIG=$CONFIG"
EnvironmentFile="$CONFIG_DIR/environment"
ExecStart="$NODE" "$PREFIX/current/bin/proxy.mjs" serve
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077
StateDirectory=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
UNIT
  if [[ ! -f "$UNIT_PATH" ]] || ! cmp -s "$TEMP/unit.next" "$UNIT_PATH"; then
    [[ ! -f "$UNIT_PATH" ]] || cp -- "$UNIT_PATH" "$TEMP/unit.before"
    UNIT_CHANGED=1
    install -m 644 "$TEMP/unit.next" "$UNIT_PATH"
    systemctl daemon-reload
  fi
fi
if [[ "$OLD_CURRENT" != "$RELEASE_DIR" ]]; then
  ln -s -- "$RELEASE_DIR" "$PREFIX/.current-$$"
  mv -Tf -- "$PREFIX/.current-$$" "$PREFIX/current"
  SWITCHED=1
  SOURCE_CHANGED=1
fi
if (( SERVICE )); then
  systemctl is-enabled --quiet "$SERVICE_NAME" || systemctl enable "$SERVICE_NAME"
  if (( SOURCE_CHANGED || RUNTIME_CHANGED || CONFIG_CHANGED || ENV_CHANGED || UNIT_CHANGED )); then
    ACTIVATION_ATTEMPTED=1
    systemctl restart "$SERVICE_NAME"
    SERVICE_ACTION='restarted'
  elif ! systemctl is-active --quiet "$SERVICE_NAME"; then
    ACTIVATION_ATTEMPTED=1
    systemctl start "$SERVICE_NAME"
    SERVICE_ACTION='started'
  else SERVICE_ACTION='unchanged'; fi
  if [[ "$SERVICE_ACTION" != unchanged ]]; then
    "$NODE" --input-type=module - "$CONFIG" <<'NODE'
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hostname = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
let success = false;
for (let attempt = 0; attempt < 30; attempt++) {
  success = await new Promise((resolve) => {
    const request = http.get({ hostname, port: config.port ?? 8787, path: '/healthz', timeout: 1500 }, (response) => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
  if (success) break;
  await wait(500);
}
if (!success) throw new Error('Proxy health check failed after service activation.');
NODE
  fi
  log "Service: $SERVICE_ACTION."
else log 'Skipped: service registration and startup (--no-service).'; fi
if (( SOURCE_CHANGED )) && [[ -n "$OLD_CURRENT" ]]; then
  ln -s -- "$OLD_CURRENT" "$PREFIX/.previous-$$"
  mv -Tf -- "$PREFIX/.previous-$$" "$PREFIX/previous"
fi
trap - ERR
printf 'source=%s\nruntime=%s\nconfig=%s\nenvironment=%s\n' "$SOURCE_SHA" "$NODE_ID" "$CONFIG_SHA" "$ENVIRONMENT_SHA" > "$TEMP/state.next"
if [[ ! -f "$PREFIX/.install-state" ]] || ! cmp -s "$TEMP/state.next" "$PREFIX/.install-state"; then
  install -m 600 "$TEMP/state.next" "$PREFIX/.install-state-$$"
  mv -f -- "$PREFIX/.install-state-$$" "$PREFIX/.install-state"
fi
log "Installed: $PREFIX/current"
log "Configuration: $CONFIG (preserved on upgrades)."
log "Updated: source=$SOURCE_CHANGED runtime=$RUNTIME_CHANGED validation=$VALIDATED config=$CONFIG_CHANGED environment=$ENV_CHANGED unit=$UNIT_CHANGED."
if (( ! SOURCE_CHANGED && ! RUNTIME_CHANGED && ! VALIDATED && ! CONFIG_CHANGED && ! ENV_CHANGED && ! UNIT_CHANGED )); then
  log 'Unchanged: skipped downloads, copies, validation and restart.'
fi
if (( ! SERVICE )); then log "Start manually: PROXY_CONFIG='$CONFIG' '$NODE' '$PREFIX/current/bin/proxy.mjs' serve"; fi

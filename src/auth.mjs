import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const REGIONS = new Set(['global', 'eu', 'us']);
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_COOLDOWN_MS = 5_000;
const MAX_CREDENTIAL_BYTES = 1_048_576;

class CredentialError extends Error {
  constructor(message, status = 401, type = 'authentication_error') {
    super(message);
    this.name = 'CredentialError';
    this.status = status;
    this.type = type;
  }
}

const unavailable = () => new CredentialError(
  'Factory login refresh is unavailable. Run droid doctor --checks auth and retry.',
  503,
  'api_error',
);

function configurationError() {
  return new CredentialError('Invalid Factory credential configuration.', 503, 'api_error');
}

function cleanString(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw configurationError();
    return undefined;
  }
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) throw configurationError();
  const result = value.trim();
  if (!result && required) throw configurationError();
  return result || undefined;
}

function regionOf(value) {
  if (!REGIONS.has(value)) throw configurationError();
  return value;
}

function jwtExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length > MAX_CREDENTIAL_BYTES) return undefined;
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > 0 && Number.isFinite(exp * 1_000)
      ? exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if ((expectedLength !== undefined && bytes.length !== expectedLength)
    || bytes.toString('base64') !== value) throw new Error();
  return bytes;
}

function decryptCredentials(ciphertext, keyText) {
  const key = decodeBase64(keyText.trim(), 32);
  try {
    const parts = ciphertext.trim().split(':');
    if (parts.length !== 3) throw new Error();
    const iv = decodeBase64(parts[0], 16);
    const tag = decodeBase64(parts[1], 16);
    const encrypted = decodeBase64(parts[2]);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } finally {
    key.fill(0);
  }
}

async function optionalCredentialFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error();
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function installedKeytarPaths(env) {
  const paths = [];
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'Factory');
    try {
      const versions = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^app-\d/u.test(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
      for (const version of versions) {
        paths.push(join(root, version, 'resources', 'app.asar.unpacked', 'node_modules',
          'keytar', 'build', 'Release', 'keytar.node'));
      }
    } catch {
      // A separately installed keytar module can still provide the OS keyring.
    }
  }
  if (process.platform === 'darwin') {
    paths.push('/Applications/Factory.app/Contents/Resources/app.asar.unpacked/node_modules/keytar/build/Release/keytar.node');
  }
  return paths;
}

function createDiskReader({ env, factoryDir, keytarPath, setSource }) {
  let keytarPromise;
  async function keytar() {
    keytarPromise ??= (async () => {
      const candidates = keytarPath
        ? [resolve(keytarPath)]
        : [...await installedKeytarPaths(env), 'keytar'];
      for (const candidate of candidates) {
        try {
          const loaded = require(candidate);
          const module = loaded.default ?? loaded;
          if (typeof module.getPassword === 'function') return module;
        } catch {
          // Loading an incompatible installation must not expose its native error.
        }
      }
      throw new CredentialError(
        'Factory keyring is unavailable. Set FACTORY_KEYTAR_PATH to the installed keytar module.',
        503,
        'api_error',
      );
    })();
    return keytarPromise;
  }

  return async function readCredentials() {
    const keyring = await optionalCredentialFile(join(factoryDir, 'auth.v2.keyring'));
    if (keyring !== undefined) {
      setSource('keyring');
      const password = await (await keytar()).getPassword('Factory CLI', 'auth-encryption-key');
      return decryptCredentials(keyring, password);
    }
    const file = await optionalCredentialFile(join(factoryDir, 'auth.v2.file'));
    if (file === undefined) {
      throw new CredentialError('Factory login was not found. Run droid and sign in first.');
    }
    setSource('keyfile');
    const keyPath = join(factoryDir, 'auth.v2.key');
    const info = await stat(keyPath);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new CredentialError('Factory credential key permissions are unsafe. Restrict auth.v2.key to its owner.');
    }
    const key = await optionalCredentialFile(keyPath);
    return decryptCredentials(file, key);
  };
}

function officialRefresh({ command, args, env, timeoutMs, signal }) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(command, args, {
      env,
      timeout: timeoutMs,
      signal,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
    }, error => {
      if (error) rejectCommand(unavailable());
      else resolveCommand();
    });
  });
}

/**
 * Reads existing Factory credentials in memory. Only the official Droid command
 * may refresh the login; this module never writes credentials or uses refresh_token.
 * Test hooks: readCredentials() returns the decrypted Factory credential object;
 * refreshCommand({ command, args, env, timeoutMs, signal }) replaces the subprocess.
 */
export function createCredentialProvider(options = {}) {
  const env = options.env ?? process.env;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : options.clock?.now?.bind(options.clock) ?? Date.now;
  const apiKeyMode = env.FACTORY_API_KEY !== undefined;
  const apiKey = apiKeyMode ? cleanString(env.FACTORY_API_KEY, { required: true }) : undefined;
  const orgOverride = cleanString(env.FACTORY_ORG_ID);
  const regionOverride = env.FACTORY_REGION === undefined
    ? undefined
    : regionOf(cleanString(env.FACTORY_REGION, { required: true }));
  const clientVersion = cleanString(env.FACTORY_CLIENT_VERSION ?? '0.244.0', { required: true });
  const timeoutMs = options.refreshTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw configurationError();
  }
  const command = cleanString(options.droidPath ?? env.FACTORY_DROID_PATH ?? 'droid', { required: true });
  const keytarPath = cleanString(options.keytarPath ?? env.FACTORY_KEYTAR_PATH);
  const factoryHome = cleanString(env.FACTORY_HOME_OVERRIDE) ?? homedir();
  const factoryDir = resolve(options.factoryDir ?? join(factoryHome, '.factory'));
  const standardProfile = (process.platform === 'win32' ? basename(factoryDir).toLowerCase() : basename(factoryDir)) === '.factory';
  const refreshSupported = standardProfile || options.refreshCommand !== undefined;
  let source = apiKeyMode ? 'api-key' : 'local-login';
  let refreshInFlight;
  let refreshAfter = 0;
  let cooldownToken;
  let refreshState = 'idle';
  const reader = options.readCredentials ?? createDiskReader({
    env,
    factoryDir,
    keytarPath,
    setSource(value) { source = value; },
  });
  const refreshCommand = options.refreshCommand ?? officialRefresh;

  function publicCredential(value) {
    return {
      token: value.token,
      ...(value.orgId ? { orgId: value.orgId } : {}),
      region: value.region,
      clientVersion,
    };
  }

  async function readCurrent() {
    try {
      const raw = await reader();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const token = cleanString(raw.access_token, { required: true });
      const orgId = orgOverride ?? cleanString(raw.active_organization_id);
      const region = regionOverride ?? regionOf(raw.whoami?.inferenceRegion
        ?? raw.whoami?.region ?? raw.region ?? 'global');
      return { token, orgId, region, expiresAt: jwtExpiry(token) };
    } catch (error) {
      if (error instanceof CredentialError && error.type !== 'api_error') throw error;
      if (error instanceof CredentialError && error.message.startsWith('Factory keyring')) throw error;
      throw new CredentialError('Cannot read Factory login credentials. Run droid and sign in, then retry.');
    }
  }

  const expired = value => value.expiresAt !== undefined && value.expiresAt <= clock();
  const needsRefresh = value => value.expiresAt !== undefined
    && value.expiresAt <= clock() + REFRESH_WINDOW_MS;

  async function invokeRefresh() {
    const childEnv = Object.fromEntries(Object.entries(env)
      .filter(([name]) => name.toUpperCase() !== 'FACTORY_API_KEY'
        && (!standardProfile || name.toUpperCase() !== 'FACTORY_HOME_OVERRIDE')));
    if (standardProfile) childEnv.FACTORY_HOME_OVERRIDE = dirname(factoryDir);
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => refreshCommand({
          command,
          args: ['doctor', '--checks', 'auth', '--json'],
          env: childEnv,
          timeoutMs,
          signal: controller.signal,
        })),
        new Promise((_, rejectCommand) => {
          timer = setTimeout(() => {
            controller.abort();
            rejectCommand(unavailable());
          }, timeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(current) {
    if (!refreshSupported) {
      refreshState = 'failed';
      throw new CredentialError('Automatic Factory login refresh requires a .factory profile directory.', 503, 'api_error');
    }
    if (refreshInFlight) return refreshInFlight;
    if (cooldownToken === current.token && clock() < refreshAfter) {
      if (expired(current)) throw unavailable();
      return current;
    }
    refreshState = 'running';
    refreshInFlight = (async () => {
      const helperSucceeded = await invokeRefresh();
      let latest;
      try {
        latest = await readCurrent();
      } catch {
        refreshState = 'failed';
        cooldownToken = current.token;
        refreshAfter = clock() + REFRESH_COOLDOWN_MS;
        throw unavailable();
      }
      cooldownToken = latest.token;
      refreshAfter = clock() + REFRESH_COOLDOWN_MS;
      const changed = latest.token !== current.token;
      if (expired(latest)) {
        refreshState = 'failed';
        throw unavailable();
      }
      refreshState = changed ? 'updated' : helperSucceeded ? 'unchanged' : 'failed';
      return latest;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  }

  return {
    async get({ forceRefresh = false, rejectedToken } = {}) {
      if (apiKeyMode) {
        return publicCredential({ token: apiKey, orgId: orgOverride, region: regionOverride ?? 'global' });
      }
      const current = await readCurrent();
      if (forceRefresh && rejectedToken !== undefined && current.token !== rejectedToken && !expired(current)) {
        return publicCredential(current);
      }
      if (!forceRefresh && !needsRefresh(current)) return publicCredential(current);
      return publicCredential(await refresh(current));
    },
    describe() {
      return { mode: apiKeyMode ? 'api-key' : 'local-login', source, refresh: refreshState };
    },
  };
}

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialProvider } from '../src/auth.mjs';

const now = 1_800_000_000_000;
const secret = 'synthetic-secret-never-log';
const jwt = (expiresAt, marker = 'first') => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expiresAt / 1_000, marker })).toString('base64url')}.signature`;
const credentials = (token = jwt(now + 600_000), extra = {}) => ({ access_token: token, refresh_token: secret, ...extra });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function encrypt(value, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64')).join(':');
}

async function keyfile(dir, value) {
  const key = randomBytes(32);
  await writeFile(join(dir, 'auth.v2.key'), `${key.toString('base64')}\n`, { mode: 0o600 });
  await writeFile(join(dir, 'auth.v2.file'), encrypt(value, key));
}

function assertSanitized(error, ...values) {
  assert.equal(error.cause, undefined);
  assert.equal(error.stderr, undefined);
  const rendered = `${error.stack}\n${JSON.stringify(error)}`;
  for (const value of [secret, ...values]) assert.equal(rendered.includes(value), false);
  return true;
}

test('API key takes priority, trims spaces and never reads or refreshes local login', async () => {
  const provider = createCredentialProvider({
    env: { FACTORY_API_KEY: ' key-value ', FACTORY_ORG_ID: ' org ', FACTORY_REGION: 'us' },
    readCredentials() { throw new Error('local login must not run'); },
    refreshCommand() { throw new Error('refresh must not run'); },
  });
  assert.deepEqual(await provider.get({ forceRefresh: true, rejectedToken: 'key-value' }), {
    token: 'key-value', orgId: 'org', region: 'us', clientVersion: '0.244.0',
  });
  assert.deepEqual(provider.describe(), { mode: 'api-key', source: 'api-key', refresh: 'idle' });
  assert.equal(JSON.stringify(provider.describe()).includes('key-value'), false);
});

test('explicitly empty API key and unsafe configuration fail without falling back', () => {
  let read = false;
  for (const value of ['', '   ', '\r\n']) {
    assert.throws(() => createCredentialProvider({
      env: { FACTORY_API_KEY: value }, readCredentials() { read = true; },
    }), error => error.status === 503 && assertSanitized(error));
  }
  assert.equal(read, false);
  assert.throws(() => createCredentialProvider({ env: { FACTORY_REGION: 'other' } }), /configuration/u);
  assert.throws(() => createCredentialProvider({ env: { FACTORY_CLIENT_VERSION: 'x\nsecret' } }), /configuration/u);
});

test('decrypts Factory base64 keyfile format without rewriting credentials', async t => {
  const dir = await fixture(t);
  const value = credentials(undefined, { active_organization_id: 'org-from-login', whoami: { inferenceRegion: 'us', region: 'global' } });
  await keyfile(dir, value);
  const before = await readFile(join(dir, 'auth.v2.file'));
  const provider = createCredentialProvider({ env: {}, factoryDir: dir, clock: () => now });
  assert.deepEqual(await provider.get(), {
    token: value.access_token, orgId: 'org-from-login', region: 'us', clientVersion: '0.244.0',
  });
  assert.equal(provider.describe().source, 'keyfile');
  assert.deepEqual(await readFile(join(dir, 'auth.v2.file')), before);
  assert.equal(JSON.stringify(provider.describe()).includes(secret), false);
});

test('FACTORY_HOME_OVERRIDE selects the same default profile for reading and refresh', async t => {
  const home = await fixture(t);
  const dir = join(home, '.factory');
  await mkdir(dir);
  await keyfile(dir, credentials(jwt(now - 1_000)));
  const updated = credentials(jwt(now + 600_000, 'updated-profile'));
  const env = { FACTORY_HOME_OVERRIDE: home };
  const provider = createCredentialProvider({
    env, clock: () => now,
    refreshCommand: async options => {
      assert.equal(options.env.FACTORY_HOME_OVERRIDE, home);
      await keyfile(join(options.env.FACTORY_HOME_OVERRIDE, '.factory'), updated);
    },
  });
  assert.equal((await provider.get()).token, updated.access_token);
  assert.deepEqual(env, { FACTORY_HOME_OVERRIDE: home });
});

test('an explicit standard profile overrides the helper home without changing caller env', async t => {
  const home = await fixture(t);
  const dir = join(home, '.factory');
  await mkdir(dir);
  await keyfile(dir, credentials(jwt(now - 1_000)));
  const originalHome = join(home, 'other-home');
  const env = { FACTORY_HOME_OVERRIDE: originalHome, factory_home_override: originalHome };
  const updated = credentials(jwt(now + 600_000, 'explicit-profile'));
  const provider = createCredentialProvider({
    env, factoryDir: dir, clock: () => now,
    refreshCommand: async options => {
      assert.equal(options.env.FACTORY_HOME_OVERRIDE, home);
      assert.equal(options.env.factory_home_override, undefined);
      await keyfile(join(options.env.FACTORY_HOME_OVERRIDE, '.factory'), updated);
    },
  });
  assert.equal((await provider.get()).token, updated.access_token);
  assert.equal(env.FACTORY_HOME_OVERRIDE, originalHome);
  assert.equal(env.factory_home_override, originalHome);
});

test('nonstandard profile directories never run the official refresh against another profile', async t => {
  const dir = await fixture(t);
  const token = jwt(now + 600_000);
  let current = credentials(token);
  const provider = createCredentialProvider({
    env: {}, factoryDir: dir, droidPath: 'must-not-execute', clock: () => now,
    readCredentials: async () => current,
  });
  assert.equal((await provider.get()).token, token);
  await assert.rejects(provider.get({ forceRefresh: true, rejectedToken: token }), error => (
    error.status === 503 && /profile directory/u.test(error.message) && assertSanitized(error)
  ));
  current = credentials(jwt(now - 1_000));
  await assert.rejects(provider.get(), /profile directory/u);
  assert.equal(provider.describe().refresh, 'failed');
});

test('loads explicitly configured keytar and reads the Factory service and account', async t => {
  const dir = await fixture(t);
  const key = randomBytes(32);
  const token = jwt(now + 600_000);
  const modulePath = join(dir, 'keytar.cjs');
  await writeFile(modulePath, `module.exports = { getPassword: async (service, account) => { if(service !== 'Factory CLI' || account !== 'auth-encryption-key') throw Error('wrong account'); return '${key.toString('base64')}'; } };`);
  await writeFile(join(dir, 'auth.v2.keyring'), encrypt(credentials(token), key));
  const provider = createCredentialProvider({ env: { FACTORY_KEYTAR_PATH: modulePath }, factoryDir: dir, clock: () => now });
  assert.equal((await provider.get()).token, token);
  assert.equal(provider.describe().source, 'keyring');
});

test('a corrupt keyring never falls back to stale file credentials', async t => {
  const dir = await fixture(t);
  const key = randomBytes(32);
  const modulePath = join(dir, 'keytar.cjs');
  await writeFile(modulePath, `module.exports = { getPassword: async () => '${key.toString('base64')}' };`);
  await keyfile(dir, credentials());
  await writeFile(join(dir, 'auth.v2.keyring'), `damaged:${secret}`);
  const provider = createCredentialProvider({ env: {}, factoryDir: dir, keytarPath: modulePath });
  await assert.rejects(provider.get(), error => error.status === 401 && assertSanitized(error, key.toString('base64')));
  assert.equal(provider.describe().source, 'keyring');
});

test('missing keyring module and malformed keyfiles return sanitized errors', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'auth.v2.keyring'), secret);
  let provider = createCredentialProvider({ env: {}, factoryDir: dir, keytarPath: join(dir, 'missing.cjs') });
  await assert.rejects(provider.get(), error => error.status === 503 && assertSanitized(error));
  await rm(join(dir, 'auth.v2.keyring'));
  await writeFile(join(dir, 'auth.v2.file'), secret);
  await writeFile(join(dir, 'auth.v2.key'), secret, { mode: 0o600 });
  provider = createCredentialProvider({ env: {}, factoryDir: dir });
  await assert.rejects(provider.get(), error => error.status === 401 && assertSanitized(error));
});

test('GCM authentication rejects tampered ciphertext without leaking plaintext or key', async t => {
  const dir = await fixture(t);
  const key = randomBytes(32);
  const parts = encrypt(credentials(), key).split(':');
  const bytes = Buffer.from(parts[2], 'base64');
  bytes[0] ^= 1;
  parts[2] = bytes.toString('base64');
  await writeFile(join(dir, 'auth.v2.key'), key.toString('base64'), { mode: 0o600 });
  await writeFile(join(dir, 'auth.v2.file'), parts.join(':'));
  const provider = createCredentialProvider({ env: {}, factoryDir: dir });
  await assert.rejects(provider.get(), error => error.status === 401 && assertSanitized(error, key.toString('base64')));
});

test('POSIX keyfiles reject group and other permissions', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t);
  await keyfile(dir, credentials());
  await chmod(join(dir, 'auth.v2.key'), 0o644);
  const provider = createCredentialProvider({ env: {}, factoryDir: dir });
  await assert.rejects(provider.get(), /permissions/u);
});

test('local login is reread for each request and environment can override region and organization', async () => {
  let current = credentials('first', { active_organization_id: 'old', whoami: { region: 'eu' } });
  const provider = createCredentialProvider({ env: {}, readCredentials: async () => current });
  assert.deepEqual(await provider.get(), { token: 'first', orgId: 'old', region: 'eu', clientVersion: '0.244.0' });
  current = credentials('second', { active_organization_id: 'new', whoami: { inferenceRegion: 'us' } });
  assert.deepEqual(await provider.get(), { token: 'second', orgId: 'new', region: 'us', clientVersion: '0.244.0' });
  const override = createCredentialProvider({
    env: { FACTORY_ORG_ID: 'override', FACTORY_REGION: 'global', FACTORY_CLIENT_VERSION: '1.2.3' },
    readCredentials: async () => current,
  });
  assert.deepEqual(await override.get(), { token: 'second', orgId: 'override', region: 'global', clientVersion: '1.2.3' });
});

test('expired login refreshes via the official helper and ignores its output', async () => {
  let current = credentials(jwt(now - 1_000));
  const next = credentials(jwt(now + 600_000, 'next'));
  let commandOptions;
  const provider = createCredentialProvider({
    env: { PATH: 'test-path', factory_api_key: secret },
    droidPath: 'custom-droid',
    clock: () => now,
    readCredentials: async () => current,
    refreshCommand: async value => { commandOptions = value; current = next; return { ok: false, stderr: secret }; },
  });
  assert.equal((await provider.get()).token, next.access_token);
  assert.equal(commandOptions.command, 'custom-droid');
  assert.deepEqual(commandOptions.args, ['doctor', '--checks', 'auth', '--json']);
  assert.equal(commandOptions.env.PATH, 'test-path');
  assert.equal(Object.keys(commandOptions.env).some(name => name.toUpperCase() === 'FACTORY_API_KEY'), false);
  assert.equal(provider.describe().refresh, 'updated');
});

test('overlapping refresh requests share one helper and reread new credentials', async () => {
  let current = credentials(jwt(now - 1_000));
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = createCredentialProvider({
    env: {}, clock: () => now, readCredentials: async () => current,
    refreshCommand: async () => { calls++; await gate; current = credentials(jwt(now + 600_000, 'new')); },
  });
  const reads = Array.from({ length: 12 }, () => provider.get());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(reads);
  assert.ok(results.every(result => result.token === current.access_token));
  assert.equal(calls, 1);
});

test('401 rereads an already changed token without starting another helper', async () => {
  let calls = 0;
  const current = credentials(jwt(now + 600_000, 'changed'));
  const provider = createCredentialProvider({
    env: {}, clock: () => now, readCredentials: async () => current,
    refreshCommand: async () => { calls++; },
  });
  assert.equal((await provider.get({ forceRefresh: true, rejectedToken: 'previous' })).token, current.access_token);
  assert.equal(calls, 0);
});

test('401 with unchanged valid token returns it once and applies a helper cooldown', async () => {
  let calls = 0;
  let time = now;
  const current = credentials(jwt(now + 600_000));
  const provider = createCredentialProvider({
    env: {}, clock: () => time, readCredentials: async () => current,
    refreshCommand: async () => { calls++; },
  });
  for (let count = 0; count < 3; count++) {
    assert.equal((await provider.get({ forceRefresh: true, rejectedToken: current.access_token })).token, current.access_token);
  }
  assert.equal(calls, 1);
  assert.equal(provider.describe().refresh, 'unchanged');
  time += 5_001;
  await provider.get({ forceRefresh: true, rejectedToken: current.access_token });
  assert.equal(calls, 2);
});

test('a helper failure still accepts a newly written valid token', async () => {
  let current = credentials(jwt(now - 1_000));
  const provider = createCredentialProvider({
    env: {}, clock: () => now, readCredentials: async () => current,
    refreshCommand: async () => {
      current = credentials(jwt(now + 600_000, 'new'));
      throw Object.assign(new Error(secret), { stderr: secret });
    },
  });
  assert.equal((await provider.get()).token, current.access_token);
  assert.equal(provider.describe().refresh, 'updated');
});

test('near-expiry token remains usable when doctor does not rotate it', async () => {
  let calls = 0;
  const current = credentials(jwt(now + 30_000));
  const provider = createCredentialProvider({
    env: {}, clock: () => now, readCredentials: async () => current,
    refreshCommand: async () => { calls++; throw new Error(secret); },
  });
  assert.equal((await provider.get()).token, current.access_token);
  assert.equal((await provider.get()).token, current.access_token);
  assert.equal(calls, 1);
});

test('unchanged expired credentials fail after a successful helper and report failed status', async () => {
  let calls = 0;
  const provider = createCredentialProvider({
    env: {}, clock: () => now, readCredentials: async () => credentials(jwt(now - 1_000)),
    refreshCommand: async () => { calls++; },
  });
  await assert.rejects(provider.get(), error => error.status === 503 && assertSanitized(error));
  await assert.rejects(provider.get(), error => error.status === 503);
  assert.equal(calls, 1);
  assert.equal(provider.describe().refresh, 'failed');
});

test('helper timeout aborts its process signal, uses cooldown and never leaks raw errors', async () => {
  let calls = 0;
  let time = now;
  let signal;
  const current = credentials(jwt(now - 1_000));
  const provider = createCredentialProvider({
    env: {}, clock: () => time, refreshTimeoutMs: 15, readCredentials: async () => current,
    refreshCommand: async options => { calls++; signal = options.signal; return new Promise(() => {}); },
  });
  await assert.rejects(provider.get(), error => error.status === 503 && error.type === 'api_error' && assertSanitized(error, current.access_token));
  assert.equal(signal.aborted, true);
  await assert.rejects(provider.get(), error => error.status === 503 && assertSanitized(error));
  assert.equal(calls, 1);
  time += 5_001;
  await assert.rejects(provider.get(), error => error.status === 503);
  assert.equal(calls, 2);
});

test('reader exceptions and invalid credentials do not expose secrets', async () => {
  for (const readCredentials of [
    async () => { throw Object.assign(new Error(secret), { cause: secret, stderr: secret }); },
    async () => credentials(`${secret}\n`),
    async () => credentials('opaque', { whoami: { inferenceRegion: secret } }),
    async () => null,
  ]) {
    const provider = createCredentialProvider({ env: {}, readCredentials });
    await assert.rejects(provider.get(), error => error.status === 401 && assertSanitized(error));
    assert.equal(JSON.stringify(provider.describe()).includes(secret), false);
  }
});

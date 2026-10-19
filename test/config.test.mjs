import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, initConfig, loadConfig } from '../src/config.mjs';

test('initialization creates a private random key and preserves existing configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-proxy-config-'));
  try {
    const path = join(dir, 'proxy.config.json');
    assert.equal((await initConfig(path)).created, true);
    const first = await readFile(path, 'utf8');
    assert.match(JSON.parse(first).proxyKey, /^[a-f0-9]{64}$/);
    assert.equal((await initConfig(path)).created, false);
    assert.equal(await readFile(path, 'utf8'), first);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await loadConfig(path, {})).host, '127.0.0.1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remote binding is an explicit configuration decision', () => {
  const proxyKey = 'x'.repeat(32);
  assert.throws(() => normalizeConfig({ proxyKey, host: '0.0.0.0' }, {}), /allowRemote/);
  assert.equal(normalizeConfig({ proxyKey, host: '0.0.0.0', allowRemote: true }, {}).host, '0.0.0.0');
  assert.equal(normalizeConfig({ proxyKey, host: '::1' }, {}).host, '::1');
});

test('invalid configuration cannot silently become an insecure default', () => {
  const proxyKey = 'x'.repeat(32);
  for (const raw of [{ proxyKey: '' }, { proxyKey: proxyKey + '\0' }, { proxyKey, port: 0 }, { proxyKey, timeoutMs: '300' }, { proxyKey, upstream: 'http://attacker.invalid' }, { proxyKey, modelAliases: { sonnet: 'gpt-test' } }, { proxyKey, models: [] }]) assert.throws(() => normalizeConfig(raw, {}));
  assert.equal(normalizeConfig({ proxyKey }, { PROXY_API_KEY: 'z'.repeat(32) }).proxyKey, 'z'.repeat(32));
});

test('configuration errors do not reflect file contents or secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-proxy-bad-config-'));
  try {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{"proxyKey":"sensitive-config-value"');
    await assert.rejects(loadConfig(path, {}), error => !error.message.includes('sensitive-config-value'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/proxy.mjs', import.meta.url));

test('Claude launcher passes proxy credentials without inherited Factory credentials or conflicting backends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-proxy-cli-'));
  const health = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok"}'); });
  health.listen(0, '127.0.0.1'); await once(health, 'listening');
  try {
    const config = join(dir, 'proxy.config.json'); const child = join(dir, 'child.mjs');
    await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: health.address().port, proxyKey: 'proxy-test-key-01234567890123456789' }));
    await writeFile(child, `console.log(JSON.stringify({factoryKeys:Object.keys(process.env).filter(k=>k.toUpperCase().startsWith('FACTORY_')),base:process.env.ANTHROPIC_BASE_URL,keyMatches:process.env.ANTHROPIC_API_KEY==='proxy-test-key-01234567890123456789',model:process.env.ANTHROPIC_MODEL,conflicts:['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].filter(k=>process.env[k])}));`);
    const { stdout, stderr } = await execute(process.execPath, [cli, 'claude', '--', child], {
      cwd: dir, windowsHide: true, timeout: 10000,
      env: { ...process.env, PROXY_CONFIG: config, CLAUDE_PATH: process.execPath,
        FACTORY_API_KEY: 'fk-operator-only-test-key', factory_refresh_token: 'operator-only-test-refresh',
        ANTHROPIC_AUTH_TOKEN: 'old-auth-token', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' },
    });
    const value = JSON.parse(stdout);
    assert.deepEqual(value.factoryKeys, []);
    assert.deepEqual(value.conflicts, []);
    assert.equal(value.keyMatches, true);
    assert.equal(value.base, `http://127.0.0.1:${health.address().port}`);
    assert.equal(value.model, 'claude-sonnet-4-6');
    assert.equal(stderr, '');
    assert.doesNotMatch(stdout, /fk-operator|operator-only|old-auth|old-oauth/);
  } finally { health.closeAllConnections(); await new Promise(resolve => health.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

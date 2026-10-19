#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { configPath, initConfig, loadConfig, VERSION } from '../src/config.mjs';
import { createProxy } from '../src/proxy.mjs';
import { createCredentialProvider } from '../src/auth.mjs';

const envPath = resolve('.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const [command = 'serve', ...args] = process.argv.slice(2);
const urlFor = config => `http://${config.host === '::1' ? '[::1]' : ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host}:${config.port}`;

async function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  const candidates = process.platform === 'win32'
    ? [join(homedir(), '.local', 'bin', 'claude.exe'), ...[process.env.APPDATA && join(process.env.APPDATA, 'npm'), ...(process.env.PATH || '').split(delimiter)].filter(Boolean).flatMap(path => [join(path, 'claude.exe'), join(path, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')])]
    : (process.env.PATH || '').split(delimiter).map(path => join(path, 'claude'));
  for (const path of candidates) if (await access(path).then(() => true, () => false)) return path;
  throw new Error('Claude Code is not installed. Install it or set CLAUDE_PATH to its executable.');
}

function clientEnvironment(config) {
  const environment = { ...process.env, ANTHROPIC_BASE_URL: urlFor(config), ANTHROPIC_API_KEY: config.proxyKey, ANTHROPIC_MODEL: config.defaultModel };
  for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith('FACTORY_')) delete environment[key];
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_AWS_BASE_URL']) delete environment[key];
  return environment;
}

try {
  if (['--help', '-h', 'help'].includes(command)) {
    console.log('Factory Anthropic Proxy\n\nnode bin/proxy.mjs init        Create a local configuration and random proxy key\nnode bin/proxy.mjs serve       Start the proxy (default)\nnode bin/proxy.mjs status      Check local health and credential availability\nnode bin/proxy.mjs claude -- … Launch installed Claude Code with proxy settings\nnode bin/proxy.mjs client-env --shell powershell|bash\n                              Print client environment for explicit shell evaluation\n\nConfiguration: PROXY_CONFIG or ./proxy.config.json; optional ./.env.');
  } else if (['--version', '-v', 'version'].includes(command)) console.log(VERSION);
  else if (command === 'init') {
    const result = await initConfig();
    console.log(`${result.created ? 'Created' : 'Preserved'} configuration: ${result.path}`);
  } else {
    if (command === 'serve') await initConfig();
    const config = await loadConfig();
    const credentials = createCredentialProvider({ factoryDir: config.factoryDir });
    if (command === 'serve') {
      const server = createProxy({ config, credentials, logger: event => console.log(JSON.stringify(event)) });
      server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? 'The configured port is already in use.' : 'Unable to start the proxy.'); process.exitCode = 1; });
      server.listen(config.port, config.host, () => {
        console.log(`Factory Anthropic Proxy ${VERSION} listening at ${urlFor(config)}`);
        console.log('Run node bin/proxy.mjs claude to launch Claude Code through this proxy.');
      });
      let shuttingDown = false;
      const stop = () => {
        if (shuttingDown) return; shuttingDown = true;
        server.close(() => process.exit(0));
        const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000); deadline.unref();
      };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    } else if (command === 'status') {
      let credentialStatus = 'unavailable';
      try { await credentials.get(); credentialStatus = 'available'; } catch { /* Only availability is shown. */ }
      let health = 'offline';
      try { const result = await fetch(`${urlFor(config)}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (result.ok && (await result.json()).version === VERSION) health = 'ok'; } catch { /* Offline is a normal status. */ }
      console.log(JSON.stringify({ version: VERSION, url: urlFor(config), health, credentials: credentialStatus }));
      if (health !== 'ok' || credentialStatus !== 'available') process.exitCode = 1;
    } else if (command === 'client-env') {
      const shellIndex = args.indexOf('--shell'); const shell = shellIndex >= 0 ? args[shellIndex + 1] : process.platform === 'win32' ? 'powershell' : 'bash';
      if (!['powershell', 'bash'].includes(shell)) throw new Error('Supported shells: powershell, bash.');
      const values = { ANTHROPIC_BASE_URL: urlFor(config), ANTHROPIC_API_KEY: config.proxyKey, ANTHROPIC_MODEL: config.defaultModel };
      if (shell === 'powershell') {
        console.log("Remove-Item Env:ANTHROPIC_AUTH_TOKEN,Env:CLAUDE_CODE_OAUTH_TOKEN,Env:CLAUDE_CODE_USE_BEDROCK,Env:CLAUDE_CODE_USE_VERTEX,Env:CLAUDE_CODE_USE_FOUNDRY -ErrorAction SilentlyContinue");
        for (const [key, value] of Object.entries(values)) console.log(`$env:${key} = '${value.replaceAll("'", "''")}'`);
      } else {
        console.log('unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY');
        for (const [key, value] of Object.entries(values)) console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
      }
    } else if (command === 'claude') {
      const executable = await findClaude();
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) throw new Error('Set CLAUDE_PATH to the native Claude Code .exe, not a .cmd shim.');
      try { const health = await fetch(`${urlFor(config)}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!health.ok) throw new Error(); }
      catch { throw new Error('Start the proxy first: node bin/proxy.mjs serve'); }
      const child = spawn(executable, args[0] === '--' ? args.slice(1) : args, { env: clientEnvironment(config), stdio: 'inherit', windowsHide: true });
      child.on('error', () => { console.error('Unable to start Claude Code.'); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    } else throw new Error('Unknown command. Run node bin/proxy.mjs --help');
  }
} catch (error) {
  console.error(error.message?.includes('Factory') || /^(?:Proxy|Set |Invalid |Unknown |Unable |Non-loopback|defaultModel|models |Supported |Claude Code|Start the proxy|Install |Configuration)/.test(error.message) ? error.message : 'The command failed. Check the configuration and local credential setup.');
  process.exitCode = 1;
}

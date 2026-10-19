import { readFile, open, mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';

export const VERSION = '0.1.1';
export const DEFAULTS = Object.freeze({
  host: '127.0.0.1', port: 8787, defaultModel: 'claude-sonnet-4-6',
  models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-5-5'],
  modelAliases: {}, allowRemote: false, timeoutMs: 300000, idleTimeoutMs: 90000,
  maxBodyBytes: 33554432, maxConcurrentRequests: 8,
});
export const isLoopback = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
export const configPath = (env = process.env) => resolve(env.PROXY_CONFIG || 'proxy.config.json');
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(value);

export function normalizeConfig(raw = {}, env = process.env) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Proxy configuration must be a JSON object.');
  const allowed = new Set([...Object.keys(DEFAULTS), 'proxyKey', 'factoryDir']);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error('Unknown proxy configuration field.');
  const config = { ...DEFAULTS, ...raw, proxyKey: env.PROXY_API_KEY ?? raw.proxyKey };
  if (typeof config.proxyKey !== 'string' || config.proxyKey.length < 24 || config.proxyKey.length > 512 || !/^[\x21-\x7e]+$/.test(config.proxyKey)) {
    throw new Error('Set a proxy key of 24–512 printable ASCII characters without spaces, or run the init command.');
  }
  if (typeof config.host !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(config.host)) throw new Error('Invalid listen host.');
  if (typeof config.allowRemote !== 'boolean' || (!isLoopback(config.host) && !config.allowRemote)) {
    throw new Error('Non-loopback listening requires allowRemote: true.');
  }
  const ranges = { port: [1, 65535], timeoutMs: [100, 3600000], idleTimeoutMs: [100, 3600000], maxBodyBytes: [1024, 134217728], maxConcurrentRequests: [1, 128] };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < low || config[key] > high) throw new Error(`Invalid ${key}.`);
  }
  if (!modelId(config.defaultModel) || !config.defaultModel.startsWith('claude-')) throw new Error('defaultModel must be a Claude model ID.');
  if (!Array.isArray(config.models) || !config.models.length || config.models.length > 100 || config.models.some(id => !modelId(id) || !id.startsWith('claude-'))) throw new Error('models must contain Claude model IDs.');
  if (!config.modelAliases || typeof config.modelAliases !== 'object' || Array.isArray(config.modelAliases) || Object.entries(config.modelAliases).some(([from, to]) => !modelId(from) || !modelId(to) || !to.startsWith('claude-'))) throw new Error('Invalid modelAliases.');
  if (config.factoryDir !== undefined && (typeof config.factoryDir !== 'string' || !config.factoryDir)) throw new Error('Invalid factoryDir.');
  config.models = [...new Set([config.defaultModel, ...config.models])];
  return config;
}

export async function loadConfig(path = configPath(), env = process.env) {
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && env.PROXY_API_KEY) return normalizeConfig({}, env);
    if (error.code === 'ENOENT') throw new Error('Proxy configuration is missing. Run: node bin/proxy.mjs init');
    throw new Error('Unable to read valid proxy configuration.');
  }
  return normalizeConfig(raw, env);
}

export async function initConfig(path = configPath()) {
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { path, created: false }; throw error; }
  try {
    await file.writeFile(JSON.stringify({ ...DEFAULTS, proxyKey: randomBytes(32).toString('hex') }, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return { path, created: true };
}

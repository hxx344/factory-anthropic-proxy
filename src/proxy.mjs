import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VERSION, isLoopback } from './config.mjs';

export const FACTORY_SYSTEM = 'You are Droid, an AI software engineering agent built by Factory.';
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(value);
const failure = (status, type, message) => Object.assign(new Error(message), { status, type });

export function adaptRequest(body, config) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw failure(400, 'invalid_request_error', 'Request body must be a JSON object.');
  if (Object.hasOwn(body, '_factory')) throw failure(400, 'invalid_request_error', '_factory is reserved for the upstream.');
  if (!modelId(body.model)) throw failure(400, 'invalid_request_error', 'A valid model is required.');
  const model = Object.hasOwn(config.modelAliases, body.model) ? config.modelAliases[body.model] : body.model;
  if (!model.startsWith('claude-')) throw failure(400, 'invalid_request_error', 'Use a Claude model ID or an explicitly configured model alias.');
  if (!Array.isArray(body.messages) || !body.messages.length || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0 || (body.stream !== undefined && typeof body.stream !== 'boolean')) {
    throw failure(400, 'invalid_request_error', 'messages and a positive max_tokens are required; stream must be boolean.');
  }
  const output = { ...body, model };
  if (body.system === undefined) output.system = FACTORY_SYSTEM;
  else if (typeof body.system === 'string') output.system = body.system.startsWith(FACTORY_SYSTEM) ? body.system : `${FACTORY_SYSTEM}\n\n${body.system}`;
  else if (Array.isArray(body.system) && body.system.every(block => block && block.type === 'text' && typeof block.text === 'string')) {
    output.system = body.system[0]?.text.startsWith(FACTORY_SYSTEM) ? body.system : [{ type: 'text', text: FACTORY_SYSTEM }, ...body.system];
  } else throw failure(400, 'invalid_request_error', 'system must be a string or an array of text blocks.');
  return output;
}

const digest = value => createHash('sha256').update(value).digest();
function authenticate(request, key) {
  const apiKey = request.headers['x-api-key'];
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string' && /^Bearer /i.test(authorization) ? authorization.slice(7) : undefined;
  if (authorization !== undefined && bearer === undefined) return false;
  const candidates = [apiKey, bearer].filter(value => value !== undefined);
  return candidates.length > 0 && candidates.every(value => typeof value === 'string' && timingSafeEqual(digest(value), digest(key)));
}

function localHostAllowed(request, config) {
  if (config.allowRemote && !isLoopback(config.host)) return true;
  try {
    const host = new URL(`http://${request.headers.host}`).hostname;
    return ['127.0.0.1', '[::1]', 'localhost'].includes(host);
  } catch { return false; }
}

function redact(message, secrets) {
  let text = typeof message === 'string' ? message : 'The upstream request failed.';
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:Bearer\s+)[^\s"<>]+/gi, 'Bearer [redacted]').replace(/\b(?:fk-|sk-)[a-zA-Z0-9_-]{12,}/g, '[redacted]').slice(0, 600);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

function sendError(response, status, type, message, id) {
  sendJson(response, status, { type: 'error', error: { type, message }, request_id: id });
}

async function readJson(request, limit, signal) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw failure(413, 'request_too_large', 'Request body exceeds the configured size limit.');
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw failure(415, 'invalid_request_error', 'Content-Type must be application/json.');
  const chunks = []; let length = 0;
  const onAbort = () => request.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > limit) throw failure(413, 'request_too_large', 'Request body exceeds the configured size limit.');
      chunks.push(chunk);
    }
  } finally { signal.removeEventListener('abort', onAbort); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure(400, 'invalid_request_error', 'Invalid JSON request body.'); }
}

async function boundedText(response, limit = 16384) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const parts = []; let length = 0;
  try {
    while (length < limit) {
      const { value, done } = await reader.read(); if (done) break;
      parts.push(Buffer.from(value).subarray(0, limit - length)); length += value.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString('utf8');
}

function upstreamHeaders(request, credential, id, stream) {
  const headers = {
    'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json',
    authorization: `Bearer ${credential.token}`, 'anthropic-version': request.headers['anthropic-version'] || '2023-06-01',
    'x-factory-client': 'sdk', 'x-client-version': credential.clientVersion || '0.244.0',
    'x-api-provider': 'anthropic', 'x-session-id': id,
  };
  if (credential.orgId) headers['x-factory-org-id'] = credential.orgId;
  if (request.headers['anthropic-beta']) headers['anthropic-beta'] = request.headers['anthropic-beta'];
  return headers;
}

function waitAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createProxy({ config, credentials, fetchImpl = globalThis.fetch, logger = () => {} }) {
  let active = 0;
  const server = createServer(async (request, response) => {
    const id = randomUUID(); const started = Date.now();
    let counted = false; let timer; let idleTimer; let credential; let status = 500;
    let timeout = false; let disconnected = false;
    const controller = new AbortController();
    const abortClient = () => { disconnected = true; controller.abort(new Error('Client disconnected')); };
    request.once('aborted', abortClient);
    response.once('close', () => { if (!response.writableFinished) abortClient(); });
    const expire = () => { timeout = true; controller.abort(new Error('Upstream timeout')); };
    try {
      if (request.headers.origin !== undefined || !localHostAllowed(request, config)) throw failure(403, 'permission_error', 'This endpoint does not accept browser origins or this Host header.');
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && ['/healthz', '/health'].includes(url.pathname)) { status = 200; return sendJson(response, status, { status: 'ok', version: VERSION }); }
      if (request.method === 'HEAD' && url.pathname === '/api/hello') { status = 204; response.writeHead(status); return response.end(); }
      if (!authenticate(request, config.proxyKey)) throw failure(401, 'authentication_error', 'A valid proxy API key is required.');
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        status = 200;
        return sendJson(response, status, { data: config.models.map(model => ({ type: 'model', id: model, display_name: model, created_at: '2026-10-20T00:00:00Z' })), has_more: false, first_id: config.models[0] ?? null, last_id: config.models.at(-1) ?? null });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        const model = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        if (!config.models.includes(model)) throw failure(404, 'not_found_error', 'Model is not in the configured discovery list.');
        status = 200; return sendJson(response, status, { type: 'model', id: model, display_name: model, created_at: '2026-10-20T00:00:00Z' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') throw failure(404, 'not_found_error', 'Factory does not expose a compatible token counting endpoint. Use the client estimate.');
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') throw failure(404, 'not_found_error', 'Endpoint not found.');
      if (active >= config.maxConcurrentRequests) { response.setHeader('retry-after', '5'); throw failure(429, 'rate_limit_error', 'Proxy concurrency limit reached.'); }
      active++; counted = true;
      timer = setTimeout(expire, config.timeoutMs); timer.unref();
      const body = adaptRequest(await readJson(request, config.maxBodyBytes, controller.signal), config);
      const serialized = JSON.stringify(body);
      credential = await waitAbort(credentials.get(), controller.signal);
      const send = auth => fetchImpl(`${auth.region === 'eu' ? 'https://api.eu.factory.ai' : 'https://api.factory.ai'}/api/llm/a/v1/messages`, {
        method: 'POST', headers: upstreamHeaders(request, auth, id, body.stream), body: serialized, signal: controller.signal, redirect: 'error',
      });
      let upstream = await send(credential);
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => {});
        const updated = await waitAbort(credentials.get({ forceRefresh: true, rejectedToken: credential.token }), controller.signal);
        if (updated.token !== credential.token) { credential = updated; upstream = await send(credential); }
        else throw failure(401, 'authentication_error', 'Factory rejected the configured credential. Sign in to Factory again or replace FACTORY_API_KEY.');
      }
      status = upstream.status;
      for (const [name, value] of upstream.headers) if (['retry-after', 'request-id', 'x-request-id'].includes(name) || name.startsWith('anthropic-ratelimit-')) response.setHeader(name, value);
      if (!upstream.ok) {
        let error;
        try { error = JSON.parse(await boundedText(upstream)); } catch { /* Do not reflect HTML errors. */ }
        const types = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };
        return sendError(response, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, types[upstream.status] || 'api_error', redact(error?.error?.message || error?.detail || `Factory returned HTTP ${upstream.status}.`, [config.proxyKey, credential.token, credential.orgId]), id);
      }
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.body || (body.stream ? !type.toLowerCase().includes('text/event-stream') : !type.toLowerCase().includes('application/json'))) {
        await upstream.body?.cancel().catch(() => {});
        throw failure(502, 'api_error', 'Factory returned an unexpected response format.');
      }
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
      response.flushHeaders();
      const touchIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(expire, config.idleTimeoutMs); idleTimer.unref(); };
      touchIdle();
      await pipeline(Readable.fromWeb(upstream.body), new Transform({ transform(chunk, encoding, callback) { touchIdle(); callback(null, chunk); } }), response, { signal: controller.signal });
    } catch (error) {
      status = timeout ? 504 : Number.isInteger(error.status) ? error.status : 502;
      if (status === 413 && !response.headersSent) response.setHeader('connection', 'close');
      if (!response.headersSent && !response.destroyed && !disconnected) sendError(response, status, timeout ? 'api_error' : error.type || 'api_error', timeout ? 'The upstream request timed out.' : redact(error.status ? error.message : 'Unable to complete the Factory request.', [config.proxyKey, credential?.token, credential?.orgId]), id);
      else if (!response.writableFinished && !response.destroyed) response.destroy();
    } finally {
      clearTimeout(timer); clearTimeout(idleTimer);
      if (counted) active--;
      request.removeListener('aborted', abortClient);
      try { logger({ event: 'request', requestId: id, status, elapsedMs: Date.now() - started }); } catch { /* Logging cannot break requests. */ }
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return server;
}

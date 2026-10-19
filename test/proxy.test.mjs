import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { createProxy } from '../src/proxy.mjs';

const PROXY_KEY = 'a'.repeat(48);
const UPSTREAM_TOKEN = 'upstream-test-token';
const ORG_ID = 'org-test';
const MODEL = 'claude-haiku-4-5-20251001';
const PREFIX = 'You are Droid, an AI software engineering agent built by Factory.';
const MESSAGE_URL = 'https://api.factory.ai/api/llm/a/v1/messages';
const encoder = new TextEncoder();

function config(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    proxyKey: PROXY_KEY,
    defaultModel: MODEL,
    models: [MODEL],
    modelAliases: { sonnet: MODEL },
    allowRemote: false,
    timeoutMs: 300_000,
    idleTimeoutMs: 90_000,
    maxBodyBytes: 33_554_432,
    maxConcurrentRequests: 8,
    ...overrides,
  };
}

function credentials({ token = UPSTREAM_TOKEN, refreshedToken = token, region = 'global' } = {}) {
  const calls = [];
  return {
    calls,
    async get(options = {}) {
      calls.push({ ...options });
      return {
        token: options.forceRefresh ? refreshedToken : token,
        orgId: ORG_ID,
        region,
        clientVersion: '0.244.0',
      };
    },
    describe() {
      return { source: 'test' };
    },
  };
}

function message(overrides = {}) {
  return { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

function successResponse() {
  return new Response(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: 'Hello back' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 4, output_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-success' } });
}

async function startProxy(t, options = {}) {
  const calls = [];
  const provider = options.credentials ?? credentials();
  const fetchImpl = options.fetchImpl ?? (() => successResponse());
  const server = createProxy({
    config: config(options.config),
    credentials: provider,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return fetchImpl(url, init);
    },
    logger: options.logger ?? (() => {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    calls,
    credentials: provider,
    request(path = '/v1/messages', init = {}) {
      return fetch(`${url}${path}`, init);
    },
    post(body = message(), options = {}) {
      const { path = '/v1/messages', headers = {}, ...init } = options;
      return fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': PROXY_KEY, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      });
    },
  };
}

async function upstreamBody(call) {
  return JSON.parse(await new Response(call.init.body).text());
}

function postWithRawHeaders(url, headers, bodyChunks) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PROXY_KEY, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode,
        headers: response.headers,
      })));
    });
    request.on('error', reject);
    if (bodyChunks) {
      for (const chunk of bodyChunks) request.write(chunk);
      request.end();
    } else request.end(JSON.stringify(message()));
  });
}

function assertAnthropicError(body, errorType) {
  assert.equal(body.type, 'error');
  assert.equal(typeof body.error?.type, 'string');
  assert.equal(typeof body.error?.message, 'string');
  assert.ok(body.error.message.length > 0);
  if (errorType) assert.equal(body.error.type, errorType);
}

async function bounded(promise, milliseconds = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pendingUntilAborted(signal, onAbort = () => {}) {
  return new Promise((_, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('accepts either local key form and rejects absent, invalid, or conflicting credentials', async (t) => {
  const proxy = await startProxy(t);
  for (const headers of [
    { 'x-api-key': PROXY_KEY },
    { authorization: `Bearer ${PROXY_KEY}` },
    { 'x-api-key': PROXY_KEY, authorization: `Bearer ${PROXY_KEY}` },
  ]) {
    const response = await proxy.request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message()),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (const headers of [
    {},
    { 'x-api-key': 'incorrect' },
    { authorization: `Basic ${PROXY_KEY}` },
    { 'x-api-key': PROXY_KEY, authorization: 'Bearer incorrect' },
    { 'x-api-key': 'incorrect', authorization: `Bearer ${PROXY_KEY}` },
  ]) {
    const response = await proxy.request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message()),
    });
    assert.equal(response.status, 401);
    assertAnthropicError(await response.json(), 'authentication_error');
  }
  assert.equal(proxy.calls.length, 3);
});

test('replaces upstream credentials and forwards only the supported client headers', async (t) => {
  const proxy = await startProxy(t);
  const response = await proxy.post(message(), { headers: {
    authorization: `Bearer ${PROXY_KEY}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
    cookie: 'session=client-secret',
    'proxy-authorization': 'Bearer injected-proxy-token',
    'x-api-provider': 'injected-provider',
    'x-organization-id': 'injected-organization',
    'x-factory-org-id': 'injected-factory-organization',
    'x-client-version': 'injected-client-version',
    'x-factory-client-version': 'injected-version',
    'x-unrelated-client-header': 'injected-unrelated',
  } });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const headers = new Headers(proxy.calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${UPSTREAM_TOKEN}`);
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
  assert.equal(headers.get('x-api-provider'), 'anthropic');
  assert.equal(headers.get('x-factory-org-id'), ORG_ID);
  assert.equal(headers.get('x-client-version'), '0.244.0');
  for (const name of ['x-api-key', 'cookie', 'proxy-authorization', 'x-unrelated-client-header']) {
    assert.equal(headers.get(name), null, name);
  }
  assert.ok(!JSON.stringify([...headers]).includes('injected-'));
});

test('accepts the beta query while using the fixed Factory upstream endpoint', async (t) => {
  const proxy = await startProxy(t);
  const response = await proxy.post(message(), { path: '/v1/messages?beta=true' });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(proxy.calls[0].url, MESSAGE_URL);
});

test('uses the fixed EU endpoint for EU credentials', async (t) => {
  const proxy = await startProxy(t, { credentials: credentials({ region: 'eu' }) });
  const response = await proxy.post();
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(proxy.calls[0].url, 'https://api.eu.factory.ai/api/llm/a/v1/messages');
});

test('prepends the required system string and preserves message/tool/thinking extensions', async (t) => {
  const proxy = await startProxy(t);
  const original = message({
    system: 'Keep every answer concise.',
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    thinking: { type: 'enabled', budget_tokens: 1_024 },
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'File contents' }] },
    ],
    custom_extension: { preserve: true },
  });
  const response = await proxy.post(original);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const forwarded = await upstreamBody(proxy.calls[0]);
  assert.equal(typeof forwarded.system, 'string');
  assert.ok(forwarded.system.startsWith(PREFIX));
  assert.ok(forwarded.system.endsWith(original.system));
  const { system: _originalSystem, ...originalRest } = original;
  const { system: _forwardedSystem, ...forwardedRest } = forwarded;
  assert.deepEqual(forwardedRest, originalRest);
});

test('prepends a system text block without changing existing cache controls', async (t) => {
  const proxy = await startProxy(t);
  const blocks = [
    { type: 'text', text: 'Project instructions', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Additional context', cache_control: { type: 'ephemeral' } },
  ];
  const response = await proxy.post(message({ system: blocks }));
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const forwarded = await upstreamBody(proxy.calls[0]);
  assert.deepEqual(forwarded.system, [{ type: 'text', text: PREFIX }, ...blocks]);
});

test('does not duplicate an existing Factory system prefix', async (t) => {
  const proxy = await startProxy(t);
  for (const system of [
    `${PREFIX}\n\nExisting instructions`,
    [{ type: 'text', text: `${PREFIX}\n\nExisting instructions`, cache_control: { type: 'ephemeral' } }],
  ]) {
    const response = await proxy.post(message({ system }));
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual((await upstreamBody(proxy.calls.at(-1))).system, system);
  }
});

test('maps explicit aliases and passes full Claude model IDs unchanged', async (t) => {
  const proxy = await startProxy(t);
  const cases = [
    { input: message({ model: 'sonnet' }), expected: MODEL },
    { input: message({ model: 'claude-future-model-20990101' }), expected: 'claude-future-model-20990101' },
    { input: message(), expected: MODEL },
  ];
  for (const { input, expected } of cases) {
    const response = await proxy.post(input);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal((await upstreamBody(proxy.calls.at(-1))).model, expected);
  }
});

test('rejects malformed JSON, nonobject bodies, and client _factory configuration', async (t) => {
  const proxy = await startProxy(t);
  for (const input of ['{"messages":', 'null', '[]', '42', message({ _factory: { upstream: 'https://attacker.invalid' } })]) {
    const response = await proxy.post(input);
    assert.equal(response.status, 400);
    assertAnthropicError(await response.json(), 'invalid_request_error');
  }
  assert.equal(proxy.calls.length, 0);
});

test('rejects bodies exceeding maxBodyBytes before contacting upstream', async (t) => {
  const proxy = await startProxy(t, { config: { maxBodyBytes: 256 } });
  const response = await proxy.post(message({ messages: [{ role: 'user', content: 'x'.repeat(1_024) }] }));
  assert.equal(response.status, 413);
  assertAnthropicError(await response.json());
  assert.equal(proxy.calls.length, 0);
});

test('returns a standard 413 for an oversized chunked body without Content-Length', async (t) => {
  const proxy = await startProxy(t, { config: { maxBodyBytes: 256 } });
  const body = JSON.stringify(message({ messages: [{ role: 'user', content: 'x'.repeat(1_024) }] }));
  const response = await bounded(postWithRawHeaders(`${proxy.url}/v1/messages`, {}, [
    body.slice(0, 128), body.slice(128, 384), body.slice(384),
  ]));
  assert.equal(response.status, 413);
  assertAnthropicError(await response.json(), 'request_too_large');
  assert.equal(proxy.calls.length, 0);
});

test('returns 429 at the concurrency limit and accepts requests after the first completes', async (t) => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let upstreamCalls = 0;
  const proxy = await startProxy(t, {
    config: { maxConcurrentRequests: 1 },
    fetchImpl: () => {
      if (upstreamCalls++ > 0) return successResponse();
      firstStarted();
      return new Promise((resolve) => { releaseFirst = () => resolve(successResponse()); });
    },
  });
  const first = proxy.post();
  await bounded(started);
  try {
    const rejected = await bounded(proxy.post());
    assert.equal(rejected.status, 429);
    assertAnthropicError(await rejected.json(), 'rate_limit_error');
    assert.equal(proxy.calls.length, 1);
  } finally {
    releaseFirst();
  }
  const completed = await bounded(first);
  assert.equal(completed.status, 200);
  await completed.arrayBuffer();
  const recovered = await bounded(proxy.post());
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  assert.equal(proxy.calls.length, 2);
});

test('protects model discovery with the same proxy key', async (t) => {
  const proxy = await startProxy(t);
  const denied = await proxy.request('/v1/models');
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
  const response = await proxy.request('/v1/models', { headers: { 'x-api-key': PROXY_KEY } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((entry) => entry.id === MODEL));
  assert.equal(proxy.calls.length, 0);
});

test('exposes public credential-free health and the lightweight hello probe', async (t) => {
  const proxy = await startProxy(t);
  const health = await proxy.request('/healthz');
  assert.equal(health.status, 200);
  const healthText = await health.text();
  assert.ok(healthText.length > 0);
  for (const secret of [PROXY_KEY, UPSTREAM_TOKEN, ORG_ID]) assert.ok(!healthText.includes(secret));
  const hello = await proxy.request('/api/hello', { method: 'HEAD' });
  assert.equal(hello.status, 204);
  assert.equal(await hello.text(), '');
  assert.equal(proxy.calls.length, 0);
});

test('returns an honest Anthropic 404 for unsupported count_tokens', async (t) => {
  const proxy = await startProxy(t);
  const response = await proxy.post(message(), { path: '/v1/messages/count_tokens' });
  assert.equal(response.status, 404);
  assertAnthropicError(await response.json(), 'not_found_error');
  assert.equal(proxy.calls.length, 0);
});

test('rejects every Origin and remote Host without adding CORS headers', async (t) => {
  const proxy = await startProxy(t);
  for (const headers of [
    { origin: 'http://localhost:3000' },
    { origin: 'null' },
    { host: 'untrusted.example' },
  ]) {
    const response = await postWithRawHeaders(`${proxy.url}/v1/messages`, headers);
    assert.equal(response.status, 403);
    assertAnthropicError(await response.json());
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(proxy.calls.length, 0);
});

test('cancels an upstream 401 body, refreshes rejected credentials, and retries once with a new token', async (t) => {
  let cancelled = 0;
  let count = 0;
  const provider = credentials({ refreshedToken: 'refreshed-upstream-token' });
  const proxy = await startProxy(t, {
    credentials: provider,
    fetchImpl() {
      if (count++ > 0) return successResponse();
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('{"error":{"message":"Expired"}}')); },
        cancel() { cancelled += 1; },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await bounded(proxy.post());
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(cancelled, 1);
  assert.equal(proxy.calls.length, 2);
  assert.ok(provider.calls.some((call) => call.forceRefresh === true && call.rejectedToken === UPSTREAM_TOKEN));
  assert.equal(new Headers(proxy.calls[1].init.headers).get('authorization'), 'Bearer refreshed-upstream-token');
});

test('does not retry a 401 when refresh returns the rejected token', async (t) => {
  const provider = credentials();
  const proxy = await startProxy(t, {
    credentials: provider,
    fetchImpl: () => new Response('{"error":{"type":"authentication_error","message":"Token expired"}}', {
      status: 401, headers: { 'content-type': 'application/json', 'request-id': 'req-auth' },
    }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 401);
  assertAnthropicError(await response.json(), 'authentication_error');
  assert.equal(proxy.calls.length, 1);
  assert.equal(provider.calls.filter((call) => call.forceRefresh).length, 1);
});

test('does not make a third upstream attempt after a second 401', async (t) => {
  const provider = credentials({ refreshedToken: 'refreshed-upstream-token' });
  const proxy = await startProxy(t, {
    credentials: provider,
    fetchImpl: () => new Response('{"error":{"type":"authentication_error","message":"Unauthorized"}}', {
      status: 401, headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 401);
  assertAnthropicError(await response.json(), 'authentication_error');
  assert.equal(proxy.calls.length, 2);
  assert.equal(provider.calls.filter((call) => call.forceRefresh).length, 1);
});

test('preserves rate-limit status and request ID without refreshing or retrying', async (t) => {
  const provider = credentials();
  const proxy = await startProxy(t, {
    credentials: provider,
    fetchImpl: () => new Response('{"error":{"type":"rate_limit_error","message":"Too many requests"}}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'request-id': 'req-rate-limit', 'retry-after': '10' },
    }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 429);
  const body = await response.json();
  assertAnthropicError(body, 'rate_limit_error');
  assert.equal(typeof body.request_id, 'string');
  assert.ok(body.request_id.length > 0);
  assert.equal(response.headers.get('request-id'), 'req-rate-limit');
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(proxy.calls.length, 1);
  assert.equal(provider.calls.filter((call) => call.forceRefresh).length, 0);
});

test('redacts upstream details and logger output containing credentials', async (t) => {
  const logs = [];
  const detail = `Backend failure: token=${UPSTREAM_TOKEN}, key=${PROXY_KEY}, org=${ORG_ID}`;
  const proxy = await startProxy(t, {
    logger: (...args) => logs.push(args),
    fetchImpl: () => new Response(JSON.stringify({ detail }), {
      status: 500, headers: { 'content-type': 'application/json', 'request-id': 'req-redaction' },
    }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 500);
  const body = await response.json();
  assertAnthropicError(body);
  for (const secret of [UPSTREAM_TOKEN, PROXY_KEY, ORG_ID]) {
    assert.ok(!JSON.stringify(body).includes(secret), `Response leaked ${secret}`);
    assert.ok(!JSON.stringify(logs).includes(secret), `Logs leaked ${secret}`);
  }
});

test('converts a large upstream HTML error to a bounded Anthropic error', async (t) => {
  const proxy = await startProxy(t, {
    fetchImpl: () => new Response(`<html><body>${'private stack trace '.repeat(2_000)}</body></html>`, {
      status: 502, headers: { 'content-type': 'text/html' },
    }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 502);
  const text = await response.text();
  assertAnthropicError(JSON.parse(text));
  assert.ok(!text.includes('<html>'));
  assert.ok(text.length < 2_048);
  assert.equal(proxy.calls.length, 1);
});

test('rejects an upstream HTML success response with a standard 502', async (t) => {
  const html = '<html><body>Private upstream login page</body></html>';
  const proxy = await startProxy(t, {
    fetchImpl: () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const response = await proxy.post();
  assert.equal(response.status, 502);
  const text = await response.text();
  assertAnthropicError(JSON.parse(text), 'api_error');
  assert.ok(!text.includes(html));
  assert.ok(!text.includes('Private upstream login page'));
  assert.equal(proxy.calls.length, 1);
});

test('streams the first SSE bytes before upstream completes and preserves fragmented tool arguments', async (t) => {
  let controller;
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","role":"assistant","content":[]}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file","input":{}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pa',
    'th\\":\\"a.txt\\"}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const proxy = await startProxy(t, {
    fetchImpl: () => new Response(new ReadableStream({
      start(value) { controller = value; controller.enqueue(encoder.encode(chunks[0])); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  let ended = false;
  try {
    const response = await bounded(proxy.post(message({ stream: true })));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const first = await bounded(reader.read());
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), chunks[0]);
    controller.enqueue(encoder.encode(chunks[1]));
    controller.enqueue(encoder.encode(chunks[2]));
    controller.close();
    ended = true;
    let text = new TextDecoder().decode(first.value);
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.equal(text, chunks.join(''));
    assert.equal(proxy.calls.length, 1);
  } finally {
    if (!ended && controller) {
      try { controller.close(); } catch { /* The proxy may already have cancelled it. */ }
    }
  }
});

test('does not retry an authentication error event after SSE output has begun', async (t) => {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Expired"}}\n\n';
  const provider = credentials({ refreshedToken: 'unused-refreshed-token' });
  const proxy = await startProxy(t, {
    credentials: provider,
    fetchImpl: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const response = await proxy.post(message({ stream: true }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), sse);
  assert.equal(proxy.calls.length, 1);
  assert.equal(provider.calls.filter((call) => call.forceRefresh).length, 0);
});

test('returns 504 and aborts upstream when the request deadline expires', async (t) => {
  let aborted = false;
  const proxy = await startProxy(t, {
    config: { timeoutMs: 60 },
    fetchImpl: (_url, init) => pendingUntilAborted(init.signal, () => { aborted = true; }),
  });
  const response = await bounded(proxy.post());
  assert.equal(response.status, 504);
  assertAnthropicError(await response.json());
  assert.equal(aborted, true);
  assert.equal(proxy.calls.length, 1);
});

test('times out stalled credential loading without aborting the shared provider', async (t) => {
  let releaseCredentials;
  const pendingCredentials = new Promise((resolve) => { releaseCredentials = resolve; });
  const optionsSeen = [];
  const provider = {
    get(options) { optionsSeen.push(options); return pendingCredentials; },
    describe() { return { source: 'isolated-pending-test' }; },
  };
  const proxy = await startProxy(t, { config: { timeoutMs: 60 }, credentials: provider });
  const expired = await bounded(proxy.post());
  assert.equal(expired.status, 504);
  assertAnthropicError(await expired.json(), 'api_error');
  assert.equal(proxy.calls.length, 0);
  assert.equal(optionsSeen[0]?.signal, undefined);
  releaseCredentials({ token: UPSTREAM_TOKEN, orgId: ORG_ID, region: 'global', clientVersion: '0.244.0' });
  const recovered = await bounded(proxy.post());
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  assert.equal(proxy.calls.length, 1);
  assert.equal(optionsSeen.length, 2);
});

test('terminates a stalled SSE response after the idle deadline', async (t) => {
  let upstreamAborted;
  const abortObserved = new Promise((resolve) => { upstreamAborted = resolve; });
  const proxy = await startProxy(t, {
    config: { idleTimeoutMs: 60 },
    fetchImpl: (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
        init.signal.addEventListener('abort', () => {
          upstreamAborted();
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const response = await bounded(proxy.post(message({ stream: true })));
  const reader = response.body.getReader();
  assert.equal((await bounded(reader.read())).done, false);
  const completion = bounded(reader.read()).then((value) => value.done, () => true);
  assert.equal(await completion, true);
  await bounded(abortObserved);
  assert.equal(proxy.calls.length, 1);
});

test('aborts the upstream operation when the streaming client cancels', async (t) => {
  let upstreamAborted;
  const abortObserved = new Promise((resolve) => { upstreamAborted = resolve; });
  const proxy = await startProxy(t, {
    fetchImpl: (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
        init.signal.addEventListener('abort', () => {
          upstreamAborted();
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const abort = new AbortController();
  const response = await bounded(proxy.post(message({ stream: true }), { signal: abort.signal }));
  const reader = response.body.getReader();
  assert.equal((await bounded(reader.read())).done, false);
  abort.abort();
  await bounded(abortObserved);
  await reader.cancel().catch(() => {});
  assert.equal(proxy.calls.length, 1);
});

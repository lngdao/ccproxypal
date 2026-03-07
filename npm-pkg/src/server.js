import http from 'node:http';
import { getToken, clearTokenCache } from './token.js';
import { openaiToAnthropic, anthropicToOpenai, translateAnthropicStream, injectClaudeCodeSystem } from './adapter.js';
import { TokenPool } from './pool.js';
import {
  getClaudeHeaders, mergeBetaFlags, transformBody,
  recordError, recordSuccess, checkCircuitBreaker, analyzeResponse,
} from './anti-ban.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ─── Shared state ────────────────────────────────────────────────────────────

/** @type {TokenPool | null} */
let pool = null;
let hubSecret = null;

export function enableHub(secret) {
  pool = new TokenPool();
  hubSecret = secret || null;
}

export function getPool() { return pool; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(data);
}

function checkSecret(req) {
  if (!hubSecret) return true; // no secret = open
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return token === hubSecret;
}

function log(level, source, msg) {
  const ts = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '✓';
  process.stderr.write(`${prefix} [${ts}] [${source}] ${msg}\n`);
}

// ─── Upstream request (with anti-ban + pool support) ─────────────────────────

async function callAnthropic(body, reqHeaders) {
  // Circuit breaker check
  const cb = checkCircuitBreaker();
  if (!cb.ok) {
    return { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: cb.reason } } };
  }

  // Transform body (tools, system prompt, streaming, field stripping)
  const transformed = transformBody({ ...body });

  // Get anti-ban headers
  const abHeaders = getClaudeHeaders();

  const makeRequest = async (accessToken) => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...abHeaders,
    };
    // Merge beta flags from client
    headers['anthropic-beta'] = mergeBetaFlags(reqHeaders['anthropic-beta']);
    if (reqHeaders['anthropic-version']) headers['anthropic-version'] = reqHeaders['anthropic-version'];

    return fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformed),
    });
  };

  // Try pool first (if hub mode), then local token
  let source = 'local';
  let providerId = null;
  let accessToken;

  if (pool) {
    const poolToken = pool.nextToken();
    if (poolToken) {
      accessToken = poolToken.accessToken;
      providerId = poolToken.providerId;
      source = 'pool';
    }
  }

  if (!accessToken) {
    try {
      const t = await getToken();
      accessToken = t.accessToken;
    } catch {
      // No local token either
      if (pool && pool.entries.length > 0) {
        return { status: 503, json: { type: 'error', error: { type: 'overloaded_error', message: 'All pool tokens exhausted' } } };
      }
      throw new Error('No token available');
    }
  }

  let res = await makeRequest(accessToken);

  // On 401 from pool token: mark unhealthy, try next
  if (res.status === 401 && source === 'pool' && providerId) {
    const transition = pool.markUnhealthy(providerId);
    if (transition) log('warn', 'pool', `${providerId} → unhealthy`);

    // Try local token as fallback
    try {
      const t = await getToken();
      res = await makeRequest(t.accessToken);
      source = 'local-fallback';
    } catch {
      // No local token, try another pool token
      const next = pool?.nextToken();
      if (next) {
        res = await makeRequest(next.accessToken);
        providerId = next.providerId;
      }
    }
  }

  // On 401 from local token: clear cache, retry once
  if (res.status === 401 && source === 'local') {
    clearTokenCache();
    try {
      const t = await getToken();
      res = await makeRequest(t.accessToken);
    } catch { /* return original 401 */ }
  }

  // Track health
  if (res.ok) {
    recordSuccess();
    if (providerId) pool?.markHealthy(providerId);
  } else {
    const preview = res.headers.get('content-type')?.includes('json')
      ? await res.clone().text().catch(() => '') : '';
    const signals = analyzeResponse(res.status, preview);
    if (signals.isBan || signals.isThrottle) {
      recordError(res.status);
      if (providerId) pool?.markUnhealthy(providerId);
      log('error', 'anti-ban', `${signals.signal} (${res.status})`);
    }
  }

  return res;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleHealth(res) {
  let tokenStatus = 'unknown';
  try { await getToken(); tokenStatus = 'valid'; } catch (e) { tokenStatus = `error: ${e.message}`; }

  const body = { status: 'ok', token: tokenStatus };
  if (pool) {
    body.pool = { total: pool.entries.length, healthy: pool.healthyCount() };
  }
  jsonResponse(res, 200, body);
}

async function handleModels(res) {
  const abHeaders = getClaudeHeaders();
  let accessToken;
  try {
    const t = await getToken();
    accessToken = t.accessToken;
  } catch {
    if (pool) {
      const pt = pool.nextToken();
      if (pt) accessToken = pt.accessToken;
    }
  }
  if (!accessToken) return jsonResponse(res, 503, { error: { message: 'No token available' } });

  const upstream = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, ...abHeaders },
  });
  const data = await upstream.json();
  const models = data.data?.map(m => ({
    id: m.id, object: 'model',
    created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 1700000000,
    owned_by: 'anthropic',
  })) ?? data;
  res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}

async function handleMessages(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch {
    return jsonResponse(res, 400, { error: { message: 'Invalid JSON' } });
  }

  const upstream = await callAnthropic(body, req.headers);

  // If callAnthropic returned a plain object (circuit breaker), handle it
  if (upstream.json) return jsonResponse(res, upstream.status, upstream.json);

  const contentType = upstream.headers.get('content-type') ?? 'application/json';

  if (body.stream) {
    res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': contentType });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } else {
    // Client wanted non-streaming but we forced stream=true.
    // If response is SSE, buffer and return final JSON. Otherwise pass through.
    if (contentType.includes('text/event-stream')) {
      const assembled = await collectSseToMessage(upstream);
      res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(assembled));
    } else {
      const data = await upstream.json();
      res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
  }
}

async function handleChatCompletions(req, res) {
  let openaiBody;
  try { openaiBody = JSON.parse(await readBody(req)); } catch {
    return jsonResponse(res, 400, { error: { message: 'Invalid JSON' } });
  }

  const clientWantsStream = openaiBody.stream ?? false;
  const anthropicBody = openaiToAnthropic(openaiBody);
  const upstream = await callAnthropic(anthropicBody, req.headers);

  if (upstream.json) return jsonResponse(res, upstream.status, upstream.json);

  const id = `chatcmpl-${Date.now()}`;
  const model = openaiBody.model ?? anthropicBody.model;

  if (clientWantsStream) {
    res.writeHead(upstream.status, {
      ...CORS_HEADERS, 'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '{}');
      res.write(`data: ${errText}\n\n`);
      res.end();
      return;
    }
    for await (const chunk of translateAnthropicStream(upstream.body, id, model)) {
      res.write(chunk);
    }
    res.end();
  } else {
    // We forced streaming — need to reassemble
    const contentType = upstream.headers.get('content-type') ?? '';
    let anthropicData;
    if (contentType.includes('text/event-stream')) {
      anthropicData = await collectSseToMessage(upstream);
    } else {
      anthropicData = await upstream.json();
    }
    if (!upstream.ok) return jsonResponse(res, upstream.status, anthropicData);
    const openaiResponse = anthropicToOpenai(anthropicData, model);
    jsonResponse(res, 200, openaiResponse);
  }
}

// ─── SSE collector (forced stream → JSON) ────────────────────────────────────

async function collectSseToMessage(resp) {
  let buffer = '';
  let message = null;
  const contentBlocks = [];
  let currentBlock = null;

  for await (const chunk of resp.body) {
    buffer += new TextDecoder().decode(chunk);
    while (buffer.includes('\n\n')) {
      const pos = buffer.indexOf('\n\n');
      const event = buffer.slice(0, pos);
      buffer = buffer.slice(pos + 2);

      for (const line of event.split('\n')) {
        const data = line.startsWith('data: ') ? line.slice(6) : null;
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }

        switch (ev.type) {
          case 'message_start':
            if (ev.message) message = { ...ev.message };
            break;
          case 'content_block_start':
            if (ev.content_block) currentBlock = { ...ev.content_block };
            break;
          case 'content_block_delta':
            if (ev.delta && currentBlock) {
              if (ev.delta.text) currentBlock.text = (currentBlock.text || '') + ev.delta.text;
              if (ev.delta.thinking) currentBlock.thinking = (currentBlock.thinking || '') + ev.delta.thinking;
              if (ev.delta.partial_json) currentBlock._partial = (currentBlock._partial || '') + ev.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            if (currentBlock) {
              if (currentBlock.type === 'tool_use' && currentBlock._partial) {
                try { currentBlock.input = JSON.parse(currentBlock._partial); } catch {}
                delete currentBlock._partial;
              }
              contentBlocks.push(currentBlock);
              currentBlock = null;
            }
            break;
          case 'message_delta':
            if (message && ev.delta) {
              if (ev.delta.stop_reason) message.stop_reason = ev.delta.stop_reason;
              if (ev.usage?.output_tokens) {
                message.usage = { ...message.usage, output_tokens: ev.usage.output_tokens };
              }
            }
            break;
        }
      }
    }
  }

  if (message) { message.content = contentBlocks; return message; }
  return { error: 'No message_start event in SSE stream' };
}

// ─── Hub endpoints ───────────────────────────────────────────────────────────

async function handleHubProvide(req, res) {
  if (!pool) return jsonResponse(res, 404, { error: 'Hub not enabled' });
  if (!checkSecret(req)) return jsonResponse(res, 401, { error: 'Invalid hub secret' });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }

  const { provider_id, access_token, expires_at } = body;
  if (!provider_id || !access_token) return jsonResponse(res, 400, { error: 'Missing provider_id or access_token' });

  pool.pruneStale();
  pool.upsert(provider_id, access_token, expires_at || Date.now() + 365 * 24 * 60 * 60 * 1000);
  const count = pool.healthyCount();
  log('info', 'hub', `Provider '${provider_id}' pushed token (pool: ${count} healthy)`);
  jsonResponse(res, 200, { ok: true, pool_size: count });
}

async function handleHubStatus(req, res) {
  if (!pool) return jsonResponse(res, 404, { error: 'Hub not enabled' });
  if (!checkSecret(req)) return jsonResponse(res, 401, { error: 'Invalid hub secret' });
  jsonResponse(res, 200, pool.status());
}

async function handleHubRevoke(req, res) {
  if (!pool) return jsonResponse(res, 404, { error: 'Hub not enabled' });
  if (!checkSecret(req)) return jsonResponse(res, 401, { error: 'Invalid hub secret' });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }

  const removed = pool.remove(body.provider_id);
  if (removed) log('info', 'hub', `Provider '${body.provider_id}' revoked`);
  jsonResponse(res, 200, { ok: true, removed });
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function createServer(port = 8082) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = req.url?.split('?')[0];

    try {
      // Core proxy routes
      if (url === '/' || url === '/health') return await handleHealth(res);
      if (url === '/v1/models' && req.method === 'GET') return await handleModels(res);
      if (url === '/v1/messages' && req.method === 'POST') return await handleMessages(req, res);
      if (url === '/v1/chat/completions' && req.method === 'POST') return await handleChatCompletions(req, res);

      // Hub routes
      if (url === '/hub/provide' && req.method === 'POST') return await handleHubProvide(req, res);
      if (url === '/hub/status' && req.method === 'GET') return await handleHubStatus(req, res);
      if (url === '/hub/revoke' && req.method === 'POST') return await handleHubRevoke(req, res);

      jsonResponse(res, 404, { error: { message: `Route not found: ${req.method} ${url}` } });
    } catch (err) {
      log('error', 'server', err.message);
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: { message: err.message } });
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`\nccproxypal proxy server running on http://localhost:${port}\n`);
    process.stdout.write(`\nEndpoints:\n`);
    process.stdout.write(`  POST http://localhost:${port}/v1/messages          (Anthropic)\n`);
    process.stdout.write(`  POST http://localhost:${port}/v1/chat/completions  (OpenAI)\n`);
    process.stdout.write(`  GET  http://localhost:${port}/v1/models\n`);
    if (pool) {
      process.stdout.write(`\nHub endpoints:\n`);
      process.stdout.write(`  POST http://localhost:${port}/hub/provide\n`);
      process.stdout.write(`  GET  http://localhost:${port}/hub/status\n`);
      process.stdout.write(`  POST http://localhost:${port}/hub/revoke\n`);
    }
    process.stdout.write(`\nPress Ctrl+C to stop.\n\n`);
  });

  server.on('error', (err) => {
    process.stderr.write(`Server error: ${err.message}\n`);
    process.exit(1);
  });

  return server;
}

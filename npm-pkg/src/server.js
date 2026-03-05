import http from 'node:http';
import { getToken, clearTokenCache } from './token.js';
import { openaiToAnthropic, anthropicToOpenai, translateAnthropicStream, injectClaudeCodeSystem } from './adapter.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const CLAUDE_CODE_BETA = 'claude-code-20250219,oauth-2025-04-20';
const USER_AGENT = 'claude-code/1.0.85';
const ANTHROPIC_VERSION = '2023-06-01';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};


// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Upstream request to Anthropic API ───────────────────────────────────────

async function callAnthropic(body, reqHeaders) {
  const { accessToken } = await getToken();

  const upstreamBody = injectClaudeCodeSystem(body);

  // Remove fields unsupported by Claude Code
  delete upstreamBody.reasoning_budget;

  const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-beta': [reqHeaders['anthropic-beta'], CLAUDE_CODE_BETA].filter(Boolean).join(','),
      'anthropic-version': reqHeaders['anthropic-version'] ?? ANTHROPIC_VERSION,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(upstreamBody),
  });

  // On 401 clear cache so next request re-loads credentials
  if (res.status === 401) clearTokenCache();

  return res;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleHealth(res) {
  let tokenStatus = 'unknown';
  try {
    await getToken();
    tokenStatus = 'valid';
  } catch (e) {
    tokenStatus = `error: ${e.message}`;
  }
  jsonResponse(res, 200, { status: 'ok', token: tokenStatus });
}

async function handleModels(res) {
  const { accessToken } = await getToken();
  const upstream = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_CODE_BETA,
      'User-Agent': USER_AGENT,
    },
  });
  const data = await upstream.json();
  // Convert Anthropic model list to OpenAI-compatible format if needed
  const models = data.data?.map((m) => ({
    id: m.id,
    object: 'model',
    created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 1700000000,
    owned_by: 'anthropic',
  })) ?? data;
  res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}

async function handleMessages(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: { message: 'Invalid JSON' } });
  }

  const upstream = await callAnthropic(body, req.headers).catch((err) => {
    throw err;
  });

  const contentType = upstream.headers.get('content-type') ?? 'application/json';

  if (body.stream) {
    res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': contentType });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } else {
    const data = await upstream.json();
    res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

async function handleChatCompletions(req, res) {
  let openaiBody;
  try {
    openaiBody = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: { message: 'Invalid JSON' } });
  }

  const anthropicBody = openaiToAnthropic(openaiBody);
  const upstream = await callAnthropic(anthropicBody, req.headers);

  const id = `chatcmpl-${Date.now()}`;
  const model = openaiBody.model ?? anthropicBody.model;

  if (openaiBody.stream) {
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
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
    const data = await upstream.json();
    if (!upstream.ok) {
      res.writeHead(upstream.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    const openaiResponse = anthropicToOpenai(data, model);
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openaiResponse));
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function createServer(port = 8082) {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = req.url?.split('?')[0];

    try {
      if (url === '/' || url === '/health') {
        await handleHealth(res);
      } else if (url === '/v1/models' && req.method === 'GET') {
        await handleModels(res);
      } else if (url === '/v1/messages' && req.method === 'POST') {
        await handleMessages(req, res);
      } else if (url === '/v1/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res);
      } else {
        jsonResponse(res, 404, { error: { message: `Route not found: ${req.method} ${url}` } });
      }
    } catch (err) {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: { message: err.message } });
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`\nccproxypal proxy server running on http://localhost:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST http://localhost:${port}/v1/messages          (Anthropic format)`);
    console.log(`  POST http://localhost:${port}/v1/chat/completions  (OpenAI format)`);
    console.log(`  GET  http://localhost:${port}/v1/models`);
    console.log(`\nClient env vars:`);
    console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log(`  export ANTHROPIC_AUTH_TOKEN=any-dummy-key`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });

  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  return server;
}

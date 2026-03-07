#!/usr/bin/env node

import { getToken, setManualToken, saveTokenToDisk } from '../src/token.js';
import { createServer, enableHub, getPool } from '../src/server.js';
import { startTunnel, isCloudflaredAvailable } from '../src/tunnel.js';
import { configureTool, removeToolConfig, listTools } from '../src/configure.js';
import { hostname } from 'node:os';

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) opts.port = parseInt(argv[++i], 10);
    else if (a === '--tunnel' || a === '-t') opts.tunnel = true;
    else if (a === '--token' && argv[i + 1]) opts.token = argv[++i];
    else if (a === '--secret' && argv[i + 1]) opts.secret = argv[++i];
    else if ((a === '--hub' || a === '-h') && argv[i + 1]) opts.hub = argv[++i];
    else if (a === '--id' && argv[i + 1]) opts.id = argv[++i];
    else if (a === '--interval' && argv[i + 1]) opts.interval = parseInt(argv[++i], 10);
    else if ((a === '--url') && argv[i + 1]) opts.url = argv[++i];
  }
  return opts;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSaveToken(argv) {
  const token = argv[0];
  if (!token) {
    process.stderr.write('Usage: ccproxypal save-token <token>\n');
    process.stderr.write('  Saves the setup token to ~/.config/ccproxypal/token\n');
    process.exit(1);
  }
  saveTokenToDisk(token);
  process.stdout.write('Token saved to ~/.config/ccproxypal/token\n');
}

async function cmdToken() {
  const token = await getToken();
  process.stdout.write(JSON.stringify({ accessToken: token.accessToken }, null, 2) + '\n');
}

async function cmdServe(argv) {
  const { port = 8082, tunnel, token, secret } = parseArgs(argv);

  if (token) {
    setManualToken(token);
    process.stdout.write('Using provided setup token.\n');
  } else {
    try { await getToken(); } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }

  // Enable hub if --secret is provided (or always enable for hub routes)
  if (secret) {
    enableHub(secret);
    process.stdout.write(`Hub mode enabled (secret protected).\n`);
  }

  if (tunnel && !isCloudflaredAvailable()) {
    process.stderr.write('Error: cloudflared not found.\nInstall with: brew install cloudflared\n');
    process.exit(1);
  }

  const server = createServer(port);

  if (tunnel) {
    startTunnel(port, {
      onError: (err) => process.stderr.write(`Tunnel: ${err.message}\n`),
    });
  }

  function shutdown() {
    process.stdout.write('\nShutting down...\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdHost(argv) {
  const { port = 8082, secret, token } = parseArgs(argv);

  if (token) {
    setManualToken(token);
    process.stdout.write('Using provided setup token.\n');
  } else {
    try { await getToken(); } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.stderr.write('Run: ccproxypal save-token <token>\n');
      process.exit(1);
    }
  }

  if (!isCloudflaredAvailable()) {
    process.stderr.write('Error: cloudflared not found.\nInstall with: brew install cloudflared\n');
    process.exit(1);
  }

  // Enable hub + pool
  enableHub(secret || null);
  process.stdout.write(`Hub mode enabled${secret ? ' (secret protected)' : ' (open access)'}.\n`);

  const server = createServer(port);

  // Start tunnel and print pool status periodically
  startTunnel(port, {
    onUrl: (url) => {
      process.stdout.write(`\nTunnel URL: ${url}\n`);
      process.stdout.write(`Share this URL with providers:\n`);
      process.stdout.write(`  ccproxypal provide --hub ${url}${secret ? ` --secret ${secret}` : ''}\n\n`);
    },
    onError: (err) => process.stderr.write(`Tunnel: ${err.message}\n`),
  });

  // Print pool status every 30s
  setInterval(() => {
    const pool = getPool();
    if (pool && pool.entries.length > 0) {
      const status = pool.status();
      process.stdout.write(`[pool] ${status.healthy}/${status.total} healthy providers\n`);
    }
  }, 30000);

  function shutdown() {
    process.stdout.write('\nShutting down...\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdProvide(argv) {
  let hubUrl = null;
  let hubSecret = null;
  let providerId = hostname();
  let intervalSec = 120;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--hub' || a === '-h') && argv[i + 1]) hubUrl = argv[++i];
    else if ((a === '--secret' || a === '-s') && argv[i + 1]) hubSecret = argv[++i];
    else if (a === '--id' && argv[i + 1]) providerId = argv[++i];
    else if (a === '--interval' && argv[i + 1]) intervalSec = parseInt(argv[++i], 10);
  }

  if (!hubUrl) {
    process.stderr.write('Error: --hub <url> is required\n');
    process.stderr.write('Usage: ccproxypal provide --hub https://hub.example.com [--secret <s>] [--id <name>] [--interval <s>]\n');
    process.exit(1);
  }

  // Trim trailing slash
  hubUrl = hubUrl.replace(/\/+$/, '');

  process.stdout.write(`Provider starting (id: ${providerId}, hub: ${hubUrl}, interval: ${intervalSec}s)\n`);

  let healthy = false;

  async function pushToken() {
    try {
      const token = await getToken();
      const headers = { 'Content-Type': 'application/json' };
      if (hubSecret) headers['Authorization'] = `Bearer ${hubSecret}`;

      const res = await fetch(`${hubUrl}/hub/provide`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider_id: providerId,
          access_token: token.accessToken,
          refresh_token: token.refreshToken || '',
          expires_at: token.expiresAt || (Date.now() + 365 * 24 * 60 * 60 * 1000),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        process.stderr.write(`Push failed (${res.status}): ${text}\n`);
        healthy = false;
        return;
      }
      const data = await res.json();
      const now = new Date().toLocaleTimeString();
      if (!healthy) process.stdout.write(`[${now}] Connected to hub (pool: ${data.pool_size} healthy)\n`);
      healthy = true;
    } catch (err) {
      process.stderr.write(`Push error: ${err.message}\n`);
      healthy = false;
    }
  }

  // Push immediately, then on interval (faster retry when unhealthy)
  await pushToken();
  const loop = () => {
    const delay = healthy ? intervalSec * 1000 : 30_000;
    setTimeout(async () => { await pushToken(); loop(); }, delay);
  };
  loop();

  process.on('SIGINT', () => { process.stdout.write('\nProvider stopped.\n'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}

async function cmdConfigure(argv) {
  const [sub, toolId] = argv;

  if (!sub) {
    process.stdout.write('Available tools:\n');
    for (const t of listTools()) {
      process.stdout.write(`  ${t.id.padEnd(14)} ${t.name} → ${t.path}\n`);
    }
    process.stdout.write('\nUsage:\n');
    process.stdout.write('  ccproxypal configure <tool> [--url <proxy_url>]\n');
    process.stdout.write('  ccproxypal configure remove <tool>\n');
    return;
  }

  if (sub === 'remove') {
    if (!toolId) {
      process.stderr.write('Usage: ccproxypal configure remove <tool>\n');
      process.exit(1);
    }
    await removeToolConfig(toolId);
    return;
  }

  let proxyUrl = 'http://localhost:8082';
  const urlIdx = argv.indexOf('--url');
  if (urlIdx !== -1 && argv[urlIdx + 1]) proxyUrl = argv[urlIdx + 1];
  const portIdx = argv.indexOf('--port');
  if (portIdx !== -1 && argv[portIdx + 1]) proxyUrl = `http://localhost:${argv[portIdx + 1]}`;

  await configureTool(sub, proxyUrl);
}

function cmdHelp() {
  process.stdout.write(
    [
      'Usage: ccproxypal <command> [options]',
      '',
      'Commands:',
      '  save-token <token>             Save setup token to disk',
      '  token                          Print saved setup token as JSON',
      '',
      '  serve                          Start proxy server',
      '  serve --tunnel                 Start proxy + Cloudflare tunnel',
      '  serve --port <port>            Custom port (default: 8082)',
      '  serve --token <sk-ant-oat01-*> Use provided setup token',
      '  serve --secret <secret>        Enable hub mode with secret',
      '',
      '  host [--secret <s>]            Start hub: proxy + tunnel + pool',
      '  host --port <port>             Custom port (default: 8082)',
      '  host --token <token>           Use provided setup token',
      '',
      '  provide --hub <url>            Push tokens to a hub pool',
      '  provide --secret <secret>      Hub authentication secret',
      '  provide --id <name>            Provider name (default: hostname)',
      '  provide --interval <seconds>   Push interval (default: 120)',
      '',
      '  configure                      List configurable tools',
      '  configure <tool> [--url <url>] Write proxy URL to tool config',
      '  configure remove <tool>        Remove proxy config from tool',
      '',
      'Examples:',
      '  # Save token and start as hub host:',
      '  ccproxypal save-token sk-ant-oat01-...',
      '  ccproxypal host --secret mysecret',
      '',
      '  # Join as provider:',
      '  ccproxypal save-token sk-ant-oat01-...',
      '  ccproxypal provide --hub https://xxxx.trycloudflare.com --secret mysecret',
      '',
      '  # Solo usage:',
      '  ccproxypal serve --tunnel',
      '  ccproxypal configure claude-code',
      '',
    ].join('\n')
  );
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

const dispatch = {
  'save-token': () => cmdSaveToken(rest).catch(bail),
  token: () => cmdToken().catch(bail),
  serve: () => cmdServe(rest).catch(bail),
  host: () => cmdHost(rest).catch(bail),
  provide: () => cmdProvide(rest).catch(bail),
  configure: () => cmdConfigure(rest).catch(bail),
  help: () => cmdHelp(),
  '--help': () => cmdHelp(),
  '-h': () => cmdHelp(),
};

function bail(err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}

if (cmd && dispatch[cmd]) {
  dispatch[cmd]();
} else {
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}

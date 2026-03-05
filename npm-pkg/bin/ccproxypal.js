#!/usr/bin/env node

import { getToken, setManualToken } from '../src/token.js';
import { createServer } from '../src/server.js';
import { startTunnel, isCloudflaredAvailable } from '../src/tunnel.js';
import { configureTool, removeToolConfig, listTools } from '../src/configure.js';

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    port: 8082,
    tunnel: false,
    accessToken: null,
    refreshToken: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) opts.port = parseInt(argv[++i], 10);
    else if (a === '--tunnel' || a === '-t') opts.tunnel = true;
    else if ((a === '--access-token' || a === '-a') && argv[i + 1]) opts.accessToken = argv[++i];
    else if ((a === '--refresh-token' || a === '-r') && argv[i + 1]) opts.refreshToken = argv[++i];
  }
  return opts;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdToken() {
  const token = await getToken();
  process.stdout.write(JSON.stringify(token, null, 2) + '\n');
}

async function cmdServe(argv) {
  const { port, tunnel, accessToken, refreshToken } = parseArgs(argv);

  // Client mode: inject tokens manually
  if (accessToken || refreshToken) {
    if (!accessToken || !refreshToken) {
      process.stderr.write('Error: --access-token and --refresh-token must both be provided.\n');
      process.exit(1);
    }
    setManualToken(accessToken, refreshToken);
    process.stdout.write('Using provided tokens (client mode).\n');
  } else {
    // Host mode: validate local credentials before starting
    try {
      await getToken();
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
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

async function cmdConfigure(argv) {
  const [sub, toolId] = argv;

  if (!sub) {
    // List tools
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

  // sub is the tool id; look for --url flag
  let proxyUrl = 'http://localhost:8082';
  const urlIdx = argv.indexOf('--url');
  if (urlIdx !== -1 && argv[urlIdx + 1]) proxyUrl = argv[urlIdx + 1];

  const portIdx = argv.indexOf('--port');
  if (portIdx !== -1 && argv[portIdx + 1]) {
    proxyUrl = `http://localhost:${argv[portIdx + 1]}`;
  }

  await configureTool(sub, proxyUrl);
}

function cmdHelp() {
  process.stdout.write(
    [
      'Usage: ccproxypal <command> [options]',
      '',
      'Commands:',
      '  token                          Print Claude OAuth tokens as JSON',
      '',
      '  serve                          Start proxy (uses local Claude credentials)',
      '  serve --tunnel                 Start proxy + Cloudflare tunnel',
      '  serve --port <port>            Custom port (default: 8082)',
      '  serve --access-token <token>   Client mode: use provided tokens',
      '         --refresh-token <token>',
      '',
      '  configure                      List configurable tools',
      '  configure <tool> [--url <url>] Write proxy URL to tool config',
      '  configure <tool> --port <port> Write http://localhost:<port> to tool config',
      '  configure remove <tool>        Remove proxy config from tool',
      '',
      'Tools:',
      '  claude-code    ~/.claude/settings.json',
      '  opencode       ~/.config/opencode/config.json',
      '',
      'Examples:',
      '  npx ccproxypal token',
      '  npx ccproxypal serve --tunnel',
      '  npx ccproxypal serve --access-token sk-ant-... --refresh-token ...',
      '  npx ccproxypal configure claude-code',
      '  npx ccproxypal configure claude-code --url https://xxxx.trycloudflare.com',
      '  npx ccproxypal configure remove claude-code',
      '',
    ].join('\n')
  );
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

const dispatch = {
  token: () => cmdToken().catch(bail),
  serve: () => cmdServe(rest).catch(bail),
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

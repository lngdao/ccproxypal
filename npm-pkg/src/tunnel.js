import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function isCloudflaredAvailable() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a cloudflared quick tunnel pointing at the given local port.
 * Calls onUrl(url) when the public URL is ready.
 * Returns the child process so the caller can kill it on exit.
 */
export function startTunnel(port, { onUrl, onError } = {}) {
  if (!isCloudflaredAvailable()) {
    const msg = 'cloudflared not found. Install with: brew install cloudflared';
    if (onError) onError(new Error(msg));
    else console.error(msg);
    return null;
  }

  console.log('Starting Cloudflare tunnel...');

  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlFound = false;

  function checkLine(line) {
    if (urlFound) return;
    const match = line.match(TUNNEL_URL_RE);
    if (match) {
      urlFound = true;
      const url = match[0];
      console.log(`\nTunnel URL: ${url}`);
      console.log(`\nClient env vars (via tunnel):`);
      console.log(`  export ANTHROPIC_BASE_URL=${url}`);
      console.log(`  export ANTHROPIC_AUTH_TOKEN=any-dummy-key\n`);
      if (onUrl) onUrl(url);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => d.split('\n').forEach(checkLine));
  child.stderr.on('data', (d) => d.split('\n').forEach(checkLine));

  child.on('error', (err) => {
    if (onError) onError(err);
    else console.error(`Tunnel error: ${err.message}`);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`cloudflared exited with code ${code}`);
    }
  });

  return child;
}

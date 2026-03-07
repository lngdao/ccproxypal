/**
 * Anti-ban: header spoofing, circuit breaker, ban detection.
 * No timing delays — keeps proxy fast and responsive.
 */

// Claude Code version rotation (weighted)
const VERSIONS = [
  { v: '2.1.70', weight: 40 },
  { v: '2.1.69', weight: 25 },
  { v: '2.1.68', weight: 15 },
  { v: '2.1.67', weight: 12 },
  { v: '2.1.66', weight: 8 },
];

const PLATFORMS = [
  '(external, cli)',
  '(external, cli, linux)',
  '(external, cli, darwin)',
];

const BETA_FEATURES = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
];

// Full Claude Code tool definitions — injected if request has no tools
const CLAUDE_CODE_TOOLS = [
  {
    name: 'Bash',
    description: 'Executes a bash command in the user\'s shell environment.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
  },
  {
    name: 'Read',
    description: 'Reads the contents of a file at the specified path.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] },
  },
  {
    name: 'Write',
    description: 'Creates or overwrites a file with the specified content.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
  },
  {
    name: 'Edit',
    description: 'Makes a targeted edit to a file by replacing an exact string match.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] },
  },
  {
    name: 'Glob',
    description: 'Finds files matching a glob pattern.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'Grep',
    description: 'Searches for a regex pattern in files.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'LS',
    description: 'Lists files and directories at the specified path.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'Task',
    description: 'Launches a sub-agent to handle a complex task independently.',
    input_schema: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' } }, required: ['description', 'prompt'] },
  },
];

const SYSTEM_PROMPT_PREFIX = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

// ─── Session state ───────────────────────────────────────────────────────────

let currentVersion = weightedPick(VERSIONS);
let currentPlatform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];

// Circuit breaker state
let consecutiveErrors = 0;
let circuitOpen = false;
let circuitOpenUntil = 0;
let tripCount = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.v;
  }
  return items[0].v;
}

// ─── Headers ─────────────────────────────────────────────────────────────────

export function getClaudeHeaders() {
  return {
    'user-agent': `claude-cli/${currentVersion} ${currentPlatform}`,
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': BETA_FEATURES.join(','),
    'anthropic-version': '2023-06-01',
    'connection': 'keep-alive',
  };
}

/** Merge client beta flags with required ones. */
export function mergeBetaFlags(clientBeta) {
  if (!clientBeta) return BETA_FEATURES.join(',');
  const ours = new Set(BETA_FEATURES);
  const merged = [...BETA_FEATURES];
  for (const beta of clientBeta.split(',').map(s => s.trim())) {
    if (!ours.has(beta)) merged.push(beta);
  }
  return merged.join(',');
}

// ─── Request transformation ──────────────────────────────────────────────────

/** Transform request body: inject tools, system prompt, force streaming. */
export function transformBody(body) {
  if (!body || typeof body !== 'object') return body;

  // Inject tools if missing
  if (!body.tools || body.tools.length === 0) {
    body.tools = CLAUDE_CODE_TOOLS;
  }

  // Force streaming (Claude Code always streams)
  body.stream = true;

  // Ensure system prompt has Claude Code prefix
  body.system = ensureSystemPrompt(body.system);

  // Strip fields unsupported by OAuth API
  delete body.reasoning_budget;
  delete body.context_management;

  // Filter invalid tools (null/empty names)
  if (Array.isArray(body.tools)) {
    body.tools = body.tools
      .map(t => {
        if (t.type === 'custom' && t.custom) {
          const { name, description, input_schema } = t.custom;
          return name ? { name, description, input_schema } : null;
        }
        return t.name ? t : null;
      })
      .filter(Boolean);
    if (body.tools.length === 0) delete body.tools;
  }

  // Default max_tokens
  if (!body.max_tokens) body.max_tokens = 16000;

  return body;
}

function ensureSystemPrompt(system) {
  const blocks = [];

  blocks.push({
    type: 'text',
    text: SYSTEM_PROMPT_PREFIX + ' You are an interactive CLI tool that helps users with software engineering tasks.',
    cache_control: { type: 'ephemeral' },
  });

  let extra = '';
  if (typeof system === 'string') {
    extra = system.replace(/^You are Claude Code.*?Use technical language when appropriate\.\s*/s, '');
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block.type === 'text' && !block.text.startsWith(SYSTEM_PROMPT_PREFIX)) {
        extra += block.text + '\n';
      }
    }
  }

  if (extra.trim()) {
    blocks.push({ type: 'text', text: extra.trim(), cache_control: { type: 'ephemeral' } });
  }

  return blocks;
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

const CB_THRESHOLD = 3;
const CB_TRIP_DURATION = [60_000, 300_000];
const CB_MAX_TRIPS = 5;
const CB_LONG_COOLDOWN = 1_800_000;

export function recordError(statusCode) {
  consecutiveErrors++;
  if (consecutiveErrors >= CB_THRESHOLD) {
    circuitOpen = true;
    tripCount++;
    const cooldown = tripCount >= CB_MAX_TRIPS
      ? CB_LONG_COOLDOWN
      : CB_TRIP_DURATION[0] + Math.random() * (CB_TRIP_DURATION[1] - CB_TRIP_DURATION[0]);
    circuitOpenUntil = Date.now() + cooldown;
    process.stderr.write(`[anti-ban] Circuit breaker OPEN (trip #${tripCount}, cooldown ${Math.ceil(cooldown / 1000)}s)\n`);
  }
}

export function recordSuccess() {
  consecutiveErrors = 0;
  if (circuitOpen && Date.now() > circuitOpenUntil) {
    circuitOpen = false;
    process.stderr.write(`[anti-ban] Circuit breaker CLOSED\n`);
  }
}

/** Check circuit breaker. Returns { ok, waitMs, reason } */
export function checkCircuitBreaker() {
  if (!circuitOpen) return { ok: true };
  if (Date.now() > circuitOpenUntil) return { ok: true, halfOpen: true };
  return {
    ok: false,
    waitMs: circuitOpenUntil - Date.now(),
    reason: `Circuit breaker open (trip #${tripCount}). ${Math.ceil((circuitOpenUntil - Date.now()) / 1000)}s remaining`,
  };
}

// ─── Response analysis ───────────────────────────────────────────────────────

/** Analyze upstream response for ban/throttle signals. */
export function analyzeResponse(status, bodyPreview) {
  if (status === 401 || status === 403) return { isBan: true, signal: `auth-rejected (${status})` };
  if (status === 429) return { isThrottle: true, signal: 'rate-limited' };
  if (status === 529) return { isThrottle: true, signal: 'overloaded' };
  if (bodyPreview) {
    const lower = bodyPreview.toLowerCase();
    if (lower.includes('abuse') || lower.includes('violation') || lower.includes('suspended')) {
      return { isBan: true, signal: 'abuse-detected' };
    }
  }
  return { ok: true };
}

// ─── Session rotation (version changes between restarts) ─────────────────────

export function rotateSession() {
  currentVersion = weightedPick(VERSIONS);
  currentPlatform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
}

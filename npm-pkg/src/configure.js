import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const TOOLS = {
  'claude-code': {
    name: 'Claude Code',
    path: () => join(homedir(), '.claude', 'settings.json'),
  },
  opencode: {
    name: 'OpenCode',
    path: () => join(homedir(), '.config', 'opencode', 'config.json'),
  },
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function configureTool(toolId, proxyUrl) {
  const tool = TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolId}\nAvailable: ${Object.keys(TOOLS).join(', ')}`);
  }

  const path = tool.path();
  const settings = readJson(path);

  if (!settings.env) settings.env = {};
  settings.env.ANTHROPIC_BASE_URL = proxyUrl;
  settings.env.ANTHROPIC_AUTH_TOKEN = 'any-dummy-key';

  await writeJson(path, settings);
  process.stdout.write(`✓ ${tool.name} configured → ${path}\n`);
  process.stdout.write(`  ANTHROPIC_BASE_URL=${proxyUrl}\n`);
}

export async function removeToolConfig(toolId) {
  const tool = TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolId}\nAvailable: ${Object.keys(TOOLS).join(', ')}`);
  }

  const path = tool.path();
  if (!existsSync(path)) {
    process.stdout.write(`Nothing to remove — ${path} does not exist.\n`);
    return;
  }

  const content = await readFile(path, 'utf8').catch(() => '{}');
  const settings = JSON.parse(content);

  if (settings.env) {
    delete settings.env.ANTHROPIC_BASE_URL;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }

  await writeJson(path, settings);
  process.stdout.write(`✓ ${tool.name} config removed → ${path}\n`);
}

export function listTools() {
  return Object.entries(TOOLS).map(([id, t]) => ({ id, name: t.name, path: t.path() }));
}

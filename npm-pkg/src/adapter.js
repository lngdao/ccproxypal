// OpenAI ↔ Anthropic format conversion + SSE stream translation

const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

// ─── Request conversion: OpenAI → Anthropic ──────────────────────────────────

export function openaiToAnthropic(body) {
  const { messages = [], model, temperature, max_tokens, tools, stream } = body;

  // Separate system messages from the conversation
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const convMsgs = messages.filter((m) => m.role !== 'system');

  // Build system blocks
  const systemBlocks = systemMsgs.map((m) => ({
    type: 'text',
    text: typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n'),
  }));

  // Convert conversation messages
  const anthropicMessages = [];
  for (const msg of convMsgs) {
    if (msg.role === 'user') {
      const content = convertUserContent(msg.content);
      // Skip user messages with empty content — Anthropic rejects them
      const isEmpty = Array.isArray(content) ? content.length === 0
        : typeof content === 'string' ? content.trim().length === 0
        : !content;
      if (isEmpty) continue;
      anthropicMessages.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content = convertAssistantContent(msg);
      if (content.length) anthropicMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Tool results must go into a user turn
      const toolResult = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
      const prev = anthropicMessages[anthropicMessages.length - 1];
      if (prev?.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
    }
  }

  // Convert tool definitions — filter out entries with null/invalid names (e.g. Cursor placeholders)
  const anthropicTools = tools
    ?.map((t) => {
      // Claude Code format: {type:"custom", custom:{name,...}} → standard
      if (t.type === 'custom' && t.custom) {
        const { name, description, input_schema } = t.custom;
        if (!name || typeof name !== 'string') return null;
        return { name, description, input_schema };
      }
      // OpenAI format: {type:"function", function:{name,...}}
      if (t.type === 'function' && t.function) {
        return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object', properties: {} } };
      }
      // Already Anthropic format — drop if name is missing/null
      if (!t.name || typeof t.name !== 'string') return null;
      return t;
    })
    .filter(Boolean);

  return {
    model: model ?? 'claude-opus-4-5',
    max_tokens: max_tokens ?? 8192,
    ...(temperature != null && { temperature }),
    ...(systemBlocks.length && { system: systemBlocks }),
    messages: anthropicMessages,
    ...(anthropicTools?.length && { tools: anthropicTools }),
    ...(stream && { stream: true }),
  };
}

function convertUserContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image_url') {
      const url = b.image_url?.url ?? b.image_url;
      if (url.startsWith('data:')) {
        const [header, data] = url.split(',');
        const media_type = header.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
        return { type: 'image', source: { type: 'base64', media_type, data } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: JSON.stringify(b) };
  });
}

function convertAssistantContent(msg) {
  const content = [];
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments, {}),
      });
    }
  }
  return content;
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ─── Response conversion: Anthropic → OpenAI (non-streaming) ─────────────────

export function anthropicToOpenai(data, model) {
  const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  const toolCalls = data.content
    ?.filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      index: i,
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

  const finishReason = data.stop_reason === 'end_turn' ? 'stop'
    : data.stop_reason === 'tool_use' ? 'tool_calls'
    : data.stop_reason ?? 'stop';

  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? data.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls?.length && { tool_calls: toolCalls }),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}

// ─── Streaming: Anthropic SSE → OpenAI SSE ───────────────────────────────────

export async function* translateAnthropicStream(responseBody, id, model) {
  const decoder = new TextDecoder();
  let buffer = '';

  // Yield the first chunk with role
  yield sseChunk(id, model, { role: 'assistant', content: '' }, null);

  // Tool call accumulator: index → { id, name, argsBuf }
  const toolAccum = {};

  for await (const raw of responseBody) {
    buffer += decoder.decode(raw, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let event;
      try { event = JSON.parse(data); } catch { continue; }

      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const { index } = event;
        toolAccum[index] = { id: event.content_block.id, name: event.content_block.name, argsBuf: '' };
        // Emit the tool call start chunk
        yield sseChunk(id, model, {
          tool_calls: [{ index, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }],
        }, null);
      } else if (event.type === 'content_block_delta') {
        const { delta } = event;
        if (delta.type === 'text_delta') {
          yield sseChunk(id, model, { content: delta.text }, null);
        } else if (delta.type === 'input_json_delta') {
          const acc = toolAccum[event.index];
          if (acc) {
            acc.argsBuf += delta.partial_json;
            yield sseChunk(id, model, {
              tool_calls: [{ index: event.index, function: { arguments: delta.partial_json } }],
            }, null);
          }
        }
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        const finishReason = event.delta.stop_reason === 'end_turn' ? 'stop'
          : event.delta.stop_reason === 'tool_use' ? 'tool_calls'
          : event.delta.stop_reason;
        yield sseChunk(id, model, {}, finishReason);
      }
    }
  }

  yield 'data: [DONE]\n\n';
}

function sseChunk(id, model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

// ─── Inject Claude Code system prompt ────────────────────────────────────────

export function injectClaudeCodeSystem(body) {
  const prefix = { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX };
  if (!body.system) {
    return { ...body, system: [prefix] };
  }
  if (typeof body.system === 'string') {
    return { ...body, system: [prefix, { type: 'text', text: body.system }] };
  }
  if (Array.isArray(body.system)) {
    return { ...body, system: [prefix, ...body.system] };
  }
  return body;
}

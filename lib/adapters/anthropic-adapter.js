// Translates between the Anthropic Messages API wire format and the normalized request shape
// consumed by lib/prompt-api-wrapper.js (spec §3.2). Unlike OpenAI, Anthropic keeps `system` as a
// top-level field (not a message with role "system") and streams a stateful sequence of named SSE
// events rather than one self-contained chunk per delta.
import { formatSSE, formatNamedSSE } from '../sse.js';

const MESSAGES_PATTERN = /\/v1\/messages$/;
const MODEL_ID = 'gemini-nano';

export function matchRequest(pathname, method) {
  if (method === 'POST' && MESSAGES_PATTERN.test(pathname)) return 'messages';
  return null;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function extractSystem(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return extractTextContent(system);
  return '';
}

export function parseRequest(body, _context) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('"messages" must be a non-empty array');
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { unsupportedReason: 'tools is not supported' };
  }
  const hasImageContent = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part && part.type === 'image')
  );
  if (hasImageContent) {
    return { unsupportedReason: 'image input is not supported' };
  }

  const messages = [];
  const system = extractSystem(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: extractTextContent(m.content) });
  }

  return {
    messages,
    stream: Boolean(body.stream),
    model: typeof body.model === 'string' ? body.model : MODEL_ID,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
  };
}

// Sent once, before the first content_block_delta (spec §3.2's streaming rows only cover OpenAI;
// this mirrors Anthropic's actual Messages API streaming sequence).
export function buildStreamPrefix(model, id) {
  return (
    formatNamedSSE('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }) + formatNamedSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  );
}

export function buildSSEChunk(delta) {
  return formatNamedSSE('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: delta },
  });
}

function mapStopReason(finishReason) {
  return finishReason === 'length' ? 'max_tokens' : 'end_turn';
}

export function buildFinalSSEChunk(_model, _id, _created, finishReason) {
  return (
    formatNamedSSE('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    formatNamedSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
      usage: { output_tokens: 0 },
    }) +
    formatNamedSSE('message_stop', { type: 'message_stop' })
  );
}

// Anthropic's stream simply ends after message_stop; there is no "[DONE]"-style sentinel.
export function buildDoneSSE() {
  return '';
}

export function buildSSEErrorChunk(message) {
  return formatSSE({ type: 'error', error: { type: 'api_error', message } });
}

export function buildNonStreamResponse(fullText, model, id, _created, finishReason = 'stop') {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: fullText }],
    model,
    stop_reason: mapStopReason(finishReason),
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: Math.ceil(fullText.length / 4) },
  };
}

export function buildErrorResponse(code, message, _status) {
  return { type: 'error', error: { type: code, message } };
}

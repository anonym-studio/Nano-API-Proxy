// Translates between the OpenAI Chat Completions wire format and the normalized request shape
// consumed by lib/prompt-api-wrapper.js (spec §3.2). Endpoint matching is path-based so it works
// whether the client's base URL is the real api.openai.com or a local mock target.
import { formatSSE, SSE_DONE } from '../sse.js';

const CHAT_COMPLETIONS_PATTERN = /\/v1\/chat\/completions$/;
const MODELS_PATTERN = /\/v1\/models$/;
const MODEL_ID = 'gemini-nano';

export function matchRequest(pathname, method) {
  if (method === 'POST' && CHAT_COMPLETIONS_PATTERN.test(pathname)) return 'chat.completions';
  if (method === 'GET' && MODELS_PATTERN.test(pathname)) return 'models';
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

// Returns either a normalized request, or { unsupportedReason } for shapes we intentionally
// don't emulate (tools, n>1, image input — spec §3.2). `_context` (kind/pathname/query) is unused
// here since this adapter only ever handles one endpoint shape, but is part of the common
// adapter interface (see lib/adapters/gemini-adapter.js, which needs it).
export function parseRequest(body, _context) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('"messages" must be a non-empty array');
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { unsupportedReason: 'tools / function calling is not supported' };
  }
  if (typeof body.n === 'number' && body.n > 1) {
    return { unsupportedReason: '"n" greater than 1 is not supported' };
  }
  const hasImageContent = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part && part.type === 'image_url')
  );
  if (hasImageContent) {
    return { unsupportedReason: 'image input is not supported' };
  }

  const messages = body.messages
    .filter((m) => m.role === 'system' || m.role === 'developer' || m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'developer' ? 'system' : m.role,
      content: extractTextContent(m.content),
    }));

  let responseConstraint;
  if (body.response_format && body.response_format.type === 'json_schema') {
    responseConstraint = body.response_format.json_schema && body.response_format.json_schema.schema;
  }

  return {
    messages,
    stream: Boolean(body.stream),
    model: typeof body.model === 'string' ? body.model : MODEL_ID,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens:
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : undefined,
    responseConstraint,
  };
}

// OpenAI's chunk format needs no envelope before the first delta (unlike Anthropic's
// message_start/content_block_start pair) — part of the common adapter interface.
export function buildStreamPrefix() {
  return '';
}

export function buildSSEChunk(delta, model, id, created) {
  return formatSSE({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  });
}

export function buildFinalSSEChunk(model, id, created, finishReason) {
  return formatSSE({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

export function buildDoneSSE() {
  return SSE_DONE;
}

export function buildSSEErrorChunk(message) {
  return formatSSE({ error: { message, type: 'internal_error' } });
}

export function buildNonStreamResponse(fullText, model, id, created, finishReason = 'stop') {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: fullText },
        finish_reason: finishReason,
      },
    ],
    // Gemini Nano does not expose real token counts; this is a rough estimate only (spec §3.2).
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(fullText.length / 4),
      total_tokens: Math.ceil(fullText.length / 4),
    },
  };
}

// `_status` (the numeric HTTP status) is unused here but part of the common adapter interface —
// lib/adapters/gemini-adapter.js's error shape needs it.
export function buildErrorResponse(code, message, _status) {
  return { error: { message, type: code, code } };
}

export function buildModelsListResponse() {
  return {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'chrome-built-in-ai' }],
  };
}

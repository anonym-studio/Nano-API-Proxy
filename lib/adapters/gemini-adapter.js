// Translates between the Google Gemini API (`generateContent` / `streamGenerateContent`) wire
// format and the normalized request shape consumed by lib/prompt-api-wrapper.js (spec §3.2).
// Unlike OpenAI/Anthropic, Gemini has no `stream` field in the request body — streaming is
// selected by which URL action the client called, so parseRequest needs the match `kind`. Gemini
// also uses "model" (not "assistant") as its assistant-turn role name.
import { formatSSE } from '../sse.js';

const GENERATE_PATTERN = /\/models\/([^/]+):(streamGenerateContent|generateContent)$/;
const MODEL_ID = 'gemini-nano';

export function matchRequest(pathname, method) {
  if (method !== 'POST') return null;
  const match = GENERATE_PATTERN.exec(pathname);
  return match ? match[2] : null;
}

function extractTextContent(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function parseRequest(body, { kind, pathname }) {
  if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
    throw new Error('"contents" must be a non-empty array');
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { unsupportedReason: 'tools is not supported' };
  }
  const hasNonTextPart = body.contents.some(
    (c) => Array.isArray(c.parts) && c.parts.some((part) => part && !('text' in part))
  );
  if (hasNonTextPart) {
    return { unsupportedReason: 'non-text content parts are not supported' };
  }

  const messages = [];
  const systemText = body.systemInstruction ? extractTextContent(body.systemInstruction.parts) : '';
  if (systemText) messages.push({ role: 'system', content: systemText });
  for (const content of body.contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    messages.push({ role, content: extractTextContent(content.parts) });
  }

  const generationConfig = body.generationConfig || {};
  const modelMatch = GENERATE_PATTERN.exec(pathname);

  let responseConstraint;
  if (generationConfig.responseMimeType === 'application/json' && generationConfig.responseSchema) {
    responseConstraint = generationConfig.responseSchema;
  }

  return {
    messages,
    stream: kind === 'streamGenerateContent',
    model: modelMatch ? modelMatch[1] : MODEL_ID,
    temperature: typeof generationConfig.temperature === 'number' ? generationConfig.temperature : undefined,
    topK: typeof generationConfig.topK === 'number' ? generationConfig.topK : undefined,
    maxTokens: typeof generationConfig.maxOutputTokens === 'number' ? generationConfig.maxOutputTokens : undefined,
    responseConstraint,
  };
}

// Each Gemini streaming chunk is a self-contained GenerateContentResponse, so no prefix envelope
// is needed before the first delta (unlike Anthropic).
export function buildStreamPrefix() {
  return '';
}

export function buildSSEChunk(delta) {
  return formatSSE({
    candidates: [{ content: { parts: [{ text: delta }], role: 'model' }, index: 0 }],
  });
}

function mapFinishReason(finishReason) {
  return finishReason === 'length' ? 'MAX_TOKENS' : 'STOP';
}

export function buildFinalSSEChunk(_model, _id, _created, finishReason) {
  return formatSSE({
    candidates: [{ content: { parts: [], role: 'model' }, finishReason: mapFinishReason(finishReason), index: 0 }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  });
}

// Gemini's stream simply ends after the last chunk; there is no "[DONE]"-style sentinel.
export function buildDoneSSE() {
  return '';
}

export function buildSSEErrorChunk(message) {
  return formatSSE({ error: { code: 500, message, status: 'INTERNAL' } });
}

export function buildNonStreamResponse(fullText, _model, _id, _created, finishReason = 'stop') {
  const tokenEstimate = Math.ceil(fullText.length / 4);
  return {
    candidates: [
      { content: { parts: [{ text: fullText }], role: 'model' }, finishReason: mapFinishReason(finishReason), index: 0 },
    ],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: tokenEstimate, totalTokenCount: tokenEstimate },
  };
}

const STATUS_TEXT = {
  400: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

export function buildErrorResponse(code, message, status) {
  return { error: { code: status || 500, message, status: STATUS_TEXT[status] || 'INTERNAL' } };
}

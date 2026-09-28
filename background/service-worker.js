// Router / state manager (spec §2.1). Registers the MAIN/ISOLATED world content scripts that
// implement Mode A interception, and answers requests relayed from scripts/relay.js by running
// them through an adapter (lib/adapters/) and the Prompt API (background/inference-router.js).
import { InferenceQueue, QueueFullError } from './inference-queue.js';
import { checkAvailability, runChatCompletion } from './inference-router.js';
import * as openaiAdapter from '../lib/adapters/openai-adapter.js';

const PORT_NAME = 'nano-api-proxy:intercept';
const DEFAULT_TARGETS = ['http://localhost/*', 'http://127.0.0.1/*'];
const CONTENT_SCRIPT_ID_MAIN = 'nano-api-proxy-interceptor';
const CONTENT_SCRIPT_ID_ISOLATED = 'nano-api-proxy-relay';
const MAX_QUEUE_LENGTH = 10;

// Order matters: the first adapter whose matchRequest() returns non-null wins.
const adapters = [openaiAdapter];

const queue = new InferenceQueue(MAX_QUEUE_LENGTH);

async function getTargets() {
  const stored = await chrome.storage.local.get('interceptTargets');
  return Array.isArray(stored.interceptTargets) && stored.interceptTargets.length > 0
    ? stored.interceptTargets
    : DEFAULT_TARGETS;
}

async function registerInterceptScripts() {
  const matches = await getTargets();
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID_MAIN, CONTENT_SCRIPT_ID_ISOLATED],
  });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ID_MAIN, CONTENT_SCRIPT_ID_ISOLATED],
    });
  }
  if (matches.length === 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID_MAIN,
      matches,
      js: ['scripts/interceptor.js'],
      world: 'MAIN',
      runAt: 'document_start',
      allFrames: true,
    },
    {
      id: CONTENT_SCRIPT_ID_ISOLATED,
      matches,
      js: ['scripts/relay.js'],
      world: 'ISOLATED',
      runAt: 'document_start',
      allFrames: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['interceptEnabled', 'interceptTargets']).then((stored) => {
    const updates = {};
    if (stored.interceptEnabled === undefined) updates.interceptEnabled = true;
    if (stored.interceptTargets === undefined) updates.interceptTargets = DEFAULT_TARGETS;
    if (Object.keys(updates).length > 0) chrome.storage.local.set(updates);
  });
  registerInterceptScripts();
});

chrome.runtime.onStartup.addListener(() => {
  registerInterceptScripts();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.interceptTargets) {
    registerInterceptScripts();
  }
});

function matchAdapter(url, method) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (err) {
    return null;
  }
  for (const adapter of adapters) {
    const kind = adapter.matchRequest(pathname, method);
    if (kind) return { adapter, kind };
  }
  return null;
}

function safeParseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  let aborted = false;
  const abortController = new AbortController();

  port.onDisconnect.addListener(() => {
    aborted = true;
    abortController.abort();
  });

  port.onMessage.addListener((message) => {
    if (!message || message.type !== 'request') return;
    handleRequest(port, message, abortController.signal, () => aborted);
  });
});

async function handleRequest(port, message, signal, isAborted) {
  const { id, url, method, body } = message;

  const match = matchAdapter(url, method);
  if (!match) {
    sendError(port, id, 400, 'unsupported_endpoint', `No adapter matches ${method} ${url}`, openaiAdapter);
    return;
  }
  const { adapter, kind } = match;

  if (kind === 'models') {
    sendJsonResponse(port, id, 200, adapter.buildModelsListResponse());
    return;
  }

  const parsedBody = safeParseJson(body);
  if (parsedBody === null) {
    sendError(port, id, 400, 'invalid_request_error', 'Request body is not valid JSON', adapter);
    return;
  }

  let normalized;
  try {
    normalized = adapter.parseChatCompletionsRequest(parsedBody);
  } catch (err) {
    sendError(port, id, 400, 'invalid_request_error', err.message, adapter);
    return;
  }

  if (normalized.unsupportedReason) {
    sendError(port, id, 400, 'invalid_request_error', normalized.unsupportedReason, adapter);
    return;
  }

  const availability = await checkAvailability();
  if (availability !== 'available') {
    sendError(
      port,
      id,
      503,
      'model_unavailable',
      `Gemini Nano is not available (status: ${availability}). Open the side panel to download the model.`,
      adapter
    );
    return;
  }

  let enqueued;
  try {
    enqueued = queue.enqueue(() => runRequest(port, id, adapter, normalized, signal, isAborted));
  } catch (err) {
    if (err instanceof QueueFullError) {
      sendError(port, id, 429, 'queue_full', 'Too many concurrent requests. Try again shortly.', adapter);
      return;
    }
    throw err;
  }

  try {
    await enqueued;
  } catch (err) {
    if (!isAborted()) {
      sendError(port, id, 500, 'internal_error', err.message || String(err), adapter);
    }
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function runRequest(port, id, adapter, normalized, signal, isAborted) {
  if (isAborted()) return;

  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${id}`;

  if (normalized.stream) {
    port.postMessage({
      type: 'response_start',
      id,
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  let fullText = '';
  let finishReason = 'stop';

  try {
    for await (const delta of runChatCompletion(normalized, signal)) {
      if (isAborted()) return;
      fullText += delta;
      if (normalized.stream) {
        port.postMessage({
          type: 'chunk',
          id,
          data: adapter.buildSSEChunk(delta, normalized.model, responseId, createdAt),
        });
      }
      // No token-count API exists for Gemini Nano; max_tokens is enforced against this estimate
      // by truncating the stream early (spec §3.2 "Max Tokens Safety").
      if (normalized.maxTokens && estimateTokens(fullText) >= normalized.maxTokens) {
        finishReason = 'length';
        break;
      }
    }
  } catch (err) {
    if (isAborted() || (err && err.name === 'AbortError')) return;
    if (normalized.stream) {
      port.postMessage({ type: 'chunk', id, data: adapter.buildSSEErrorChunk(err.message || String(err)) });
      port.postMessage({ type: 'response_end', id });
    } else {
      port.postMessage({ type: 'error', id, message: err.message || String(err) });
    }
    return;
  }

  if (isAborted()) return;

  if (normalized.stream) {
    port.postMessage({
      type: 'chunk',
      id,
      data: adapter.buildFinalSSEChunk(normalized.model, responseId, createdAt, finishReason),
    });
    port.postMessage({ type: 'chunk', id, data: adapter.buildDoneSSE() });
    port.postMessage({ type: 'response_end', id });
  } else {
    const response = adapter.buildNonStreamResponse(fullText, normalized.model, responseId, createdAt, finishReason);
    sendJsonResponse(port, id, 200, response);
  }
}

function sendJsonResponse(port, id, status, jsonBody) {
  port.postMessage({ type: 'response_start', id, status, headers: { 'Content-Type': 'application/json' } });
  port.postMessage({ type: 'chunk', id, data: JSON.stringify(jsonBody) });
  port.postMessage({ type: 'response_end', id });
}

function sendError(port, id, status, code, message, adapter) {
  sendJsonResponse(port, id, status, adapter.buildErrorResponse(code, message));
}

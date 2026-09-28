// Router / state manager (spec §2.1). Registers the MAIN/ISOLATED world content scripts that
// implement Mode A interception, and answers requests relayed from scripts/relay.js by running
// them through an adapter (lib/adapters/) and the Prompt API (background/inference-router.js).
import { InferenceQueue, QueueFullError } from './inference-queue.js';
import { checkAvailability, runChatCompletion } from './inference-router.js';
import * as activityLog from './activity-log.js';
import { startServer, stopServer, setRequestHandler } from './native-server.js';
import * as openaiAdapter from '../lib/adapters/openai-adapter.js';
import * as anthropicAdapter from '../lib/adapters/anthropic-adapter.js';
import * as geminiAdapter from '../lib/adapters/gemini-adapter.js';

const PORT_NAME = 'nano-api-proxy:intercept';
const SIDE_PANEL_PORT_NAME = 'nano-api-proxy:sidepanel';
const DEFAULT_TARGETS = ['http://localhost/*', 'http://127.0.0.1/*'];
const CONTENT_SCRIPT_ID_MAIN = 'nano-api-proxy-interceptor';
const CONTENT_SCRIPT_ID_ISOLATED = 'nano-api-proxy-relay';
const MAX_QUEUE_LENGTH = 10;

// Order matters: the first adapter whose matchRequest() returns non-null wins. Each vendor's
// endpoint shape (path pattern) is disjoint from the others, so order has no real effect today.
const adapters = [openaiAdapter, anthropicAdapter, geminiAdapter];

const queue = new InferenceQueue(MAX_QUEUE_LENGTH);

activityLog.restoreFromSession();
setRequestHandler(handleRequest);

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

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

// chrome.runtime.onInstalled, onStartup, and storage.onChanged can all fire registration in
// quick succession (e.g. onInstalled's own storage.local.set() below triggers storage.onChanged
// before onInstalled's direct call finishes). registerInterceptScripts() reads the current
// registration state and then writes it, so two overlapping calls can both see "nothing
// registered yet" and both try to register the same script id, which Chrome rejects with
// "Duplicate script ID". Serialize all callers through one promise chain instead of calling
// registerInterceptScripts() directly.
let registrationChain = Promise.resolve();
function scheduleRegisterInterceptScripts() {
  registrationChain = registrationChain.then(registerInterceptScripts).catch((err) => {
    console.error('nano-api-proxy: failed to register intercept scripts', err);
  });
  return registrationChain;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['interceptEnabled', 'interceptTargets']).then((stored) => {
    const updates = {};
    if (stored.interceptEnabled === undefined) updates.interceptEnabled = true;
    if (stored.interceptTargets === undefined) updates.interceptTargets = DEFAULT_TARGETS;
    if (Object.keys(updates).length > 0) chrome.storage.local.set(updates);
  });
  scheduleRegisterInterceptScripts();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleRegisterInterceptScripts();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.interceptTargets) {
    scheduleRegisterInterceptScripts();
  }
});

function matchAdapter(url, method) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return null;
  }
  for (const adapter of adapters) {
    const kind = adapter.matchRequest(parsed.pathname, method);
    if (kind) return { adapter, kind, pathname: parsed.pathname, query: parsed.search };
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
  if (port.name === SIDE_PANEL_PORT_NAME) {
    activityLog.attachSidePanelPort(port);
    return;
  }
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type === 'server:start') {
    startServer(message.port).then(sendResponse);
    return true;
  }
  if (message.type === 'server:stop') {
    stopServer().then(sendResponse);
    return true;
  }
  if (message.type === 'log:clear') {
    activityLog.clearLog();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function handleRequest(port, message, signal, isAborted) {
  const { id, url, method, body, pageUrl, source } = message;

  const match = matchAdapter(url, method);
  if (!match) {
    sendError(port, id, 400, 'unsupported_endpoint', `No adapter matches ${method} ${url}`, openaiAdapter);
    return;
  }
  const { adapter, kind, pathname, query } = match;

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
    normalized = adapter.parseRequest(parsedBody, { kind, pathname, query });
  } catch (err) {
    sendError(port, id, 400, 'invalid_request_error', err.message, adapter);
    return;
  }

  if (normalized.unsupportedReason) {
    sendError(port, id, 400, 'invalid_request_error', normalized.unsupportedReason, adapter);
    return;
  }

  // Settings tab: "System Prompt Override" replaces whatever system/developer messages the
  // client sent, letting a fixed test prompt drive the model regardless of the app under test.
  const { systemPromptOverride } = await chrome.storage.local.get('systemPromptOverride');
  if (systemPromptOverride) {
    normalized.messages = [
      { role: 'system', content: systemPromptOverride },
      ...normalized.messages.filter((m) => m.role !== 'system'),
    ];
  }

  activityLog.createLogEntry({
    id,
    source: source || 'in-browser',
    method,
    url,
    origin: pageUrl,
    messagesPreview: normalized.messages,
  });

  const availability = await checkAvailability();
  if (availability !== 'available') {
    const errMessage = `Gemini Nano is not available (status: ${availability}). Open the side panel to download the model.`;
    activityLog.completeLogEntry(id, { status: '503 Service Unavailable', responseText: errMessage });
    sendError(port, id, 503, 'model_unavailable', errMessage, adapter);
    return;
  }

  let enqueued;
  try {
    enqueued = queue.enqueue(() => runRequest(port, id, adapter, normalized, signal, isAborted));
  } catch (err) {
    if (err instanceof QueueFullError) {
      const errMessage = 'Too many concurrent requests. Try again shortly.';
      activityLog.completeLogEntry(id, { status: '429 Too Many Requests', responseText: errMessage });
      sendError(port, id, 429, 'queue_full', errMessage, adapter);
      return;
    }
    throw err;
  }

  try {
    await enqueued;
  } catch (err) {
    if (!isAborted()) {
      const errMessage = err.message || String(err);
      activityLog.completeLogEntry(id, { status: '500 Internal Error', responseText: errMessage });
      sendError(port, id, 500, 'internal_error', errMessage, adapter);
    } else {
      activityLog.completeLogEntry(id, { status: 'Cancelled', responseText: '' });
    }
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRequest(port, id, adapter, normalized, signal, isAborted) {
  if (isAborted()) return;

  const { latencyTtftMs, latencyJitterMs } = await chrome.storage.local.get([
    'latencyTtftMs',
    'latencyJitterMs',
  ]);
  const ttftDelayMs = Number(latencyTtftMs) || 0;
  const jitterMs = Number(latencyJitterMs) || 0;

  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${id}`;

  if (normalized.stream) {
    port.postMessage({
      type: 'response_start',
      id,
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
    // Anthropic needs a message_start/content_block_start envelope before any delta; OpenAI and
    // Gemini return '' here and send nothing (spec §3.2 adapter interface).
    const prefix = adapter.buildStreamPrefix(normalized.model, responseId, createdAt);
    if (prefix) port.postMessage({ type: 'chunk', id, data: prefix });
  }

  let fullText = '';
  let finishReason = 'stop';
  let firstToken = true;

  try {
    for await (const delta of runChatCompletion(normalized, signal)) {
      if (isAborted()) return;
      if (firstToken) {
        firstToken = false;
        if (ttftDelayMs > 0) await sleep(ttftDelayMs);
        if (isAborted()) return;
        activityLog.markFirstToken(id);
      } else if (jitterMs > 0) {
        await sleep(jitterMs);
        if (isAborted()) return;
      }
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
    if (isAborted() || (err && err.name === 'AbortError')) {
      activityLog.completeLogEntry(id, { status: 'Cancelled', responseText: fullText });
      return;
    }
    const errMessage = err.message || String(err);
    activityLog.completeLogEntry(id, { status: '500 Internal Error', responseText: errMessage });
    if (normalized.stream) {
      port.postMessage({ type: 'chunk', id, data: adapter.buildSSEErrorChunk(errMessage) });
      port.postMessage({ type: 'response_end', id });
    } else {
      port.postMessage({ type: 'error', id, message: errMessage });
    }
    return;
  }

  if (isAborted()) {
    activityLog.completeLogEntry(id, { status: 'Cancelled', responseText: fullText });
    return;
  }

  activityLog.completeLogEntry(id, { status: '200 OK', responseText: fullText });

  if (normalized.stream) {
    port.postMessage({
      type: 'chunk',
      id,
      data: adapter.buildFinalSSEChunk(normalized.model, responseId, createdAt, finishReason),
    });
    const doneMarker = adapter.buildDoneSSE();
    if (doneMarker) port.postMessage({ type: 'chunk', id, data: doneMarker });
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
  sendJsonResponse(port, id, status, adapter.buildErrorResponse(code, message, status));
}

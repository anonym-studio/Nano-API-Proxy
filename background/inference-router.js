// Picks between running Prompt API inference directly in the service worker (Chrome 138+, the
// common case) or delegating to the offscreen document fallback when `LanguageModel` is not
// exposed in this context (spec §5, item 5 — "未確定事項" §8.1). Callers (service-worker.js) use
// this module instead of lib/prompt-api-wrapper.js directly so the fallback is transparent.
import * as directWrapper from '../lib/prompt-api-wrapper.js';

const OFFSCREEN_URL = 'background/offscreen.html';
const OFFSCREEN_PORT_NAME = 'nano-api-proxy:offscreen-inference';

let offscreenReady = null;

function hasDirectLanguageModel() {
  return typeof LanguageModel !== 'undefined';
}

async function ensureOffscreenDocument() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (existing.length === 0) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['WORKERS'],
          justification: 'Run Chrome built-in AI (Gemini Nano) inference when unavailable in the service worker.',
        });
      }
    })();
  }
  return offscreenReady;
}

export async function checkAvailability(options) {
  if (hasDirectLanguageModel()) {
    return directWrapper.checkAvailability(options);
  }
  await ensureOffscreenDocument();
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME });
    port.onMessage.addListener((message) => {
      if (message && message.type === 'availability') {
        resolve(message.value);
        port.disconnect();
      }
    });
    port.postMessage({ type: 'check_availability', options });
  });
}

export async function* runChatCompletion(normalized, signal) {
  if (hasDirectLanguageModel()) {
    yield* directWrapper.runChatCompletion(normalized, signal);
    return;
  }

  await ensureOffscreenDocument();
  const port = chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME });

  const pending = [];
  let waiter = null;
  let failure = null;

  function settle(entry) {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(entry);
    } else {
      pending.push(entry);
    }
  }

  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'chunk') {
      settle({ done: false, value: message.delta });
    } else if (message.type === 'done') {
      settle({ done: true });
    } else if (message.type === 'error') {
      failure = new Error(message.message);
      settle({ done: true });
    }
  });

  const onAbort = () => {
    try {
      port.postMessage({ type: 'cancel' });
    } catch (err) {
      // port may already be disconnected; ignore
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  port.postMessage({ type: 'run', normalized });

  try {
    while (true) {
      const entry = pending.length > 0 ? pending.shift() : await new Promise((resolve) => (waiter = resolve));
      if (entry.done) {
        if (failure) throw failure;
        return;
      }
      yield entry.value;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      port.disconnect();
    } catch (err) {
      // already disconnected; ignore
    }
  }
}

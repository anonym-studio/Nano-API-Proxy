// Fallback inference host, only used when `LanguageModel` is not exposed in the service worker
// context (background/inference-router.js decides this). Only chrome.runtime is usable inside an
// offscreen document, so all communication goes through this one Port protocol.
import * as wrapper from '../lib/prompt-api-wrapper.js';

const PORT_NAME = 'nano-api-proxy:offscreen-inference';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const controller = new AbortController();

  port.onMessage.addListener(async (message) => {
    if (!message) return;

    if (message.type === 'check_availability') {
      const value = await wrapper.checkAvailability(message.options);
      port.postMessage({ type: 'availability', value });
      return;
    }

    if (message.type === 'run') {
      try {
        for await (const delta of wrapper.runChatCompletion(message.normalized, controller.signal)) {
          port.postMessage({ type: 'chunk', delta });
        }
        port.postMessage({ type: 'done' });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          port.postMessage({ type: 'done' });
          return;
        }
        port.postMessage({ type: 'error', message: err.message || String(err) });
      }
      return;
    }

    if (message.type === 'cancel') {
      controller.abort();
    }
  });
});

// Manages the Mode B (external HTTP) Native Messaging Host lifecycle: launching the binary,
// the one-time {type:"start", port} handshake, and feeding inbound HTTP requests into the exact
// same handleRequest() pipeline Mode A uses (spec §2.2). `chrome.runtime.connectNative()` returns
// a Port with the same postMessage/onMessage/onDisconnect shape as an in-page content-script
// Port, so service-worker.js's handleRequest/runRequest need no branching to support both modes.
const HOST_NAME = 'com.local.nano.proxy';

let nativePort = null;
let requestHandler = null; // set via setRequestHandler() to avoid a circular import with service-worker.js
const abortControllers = new Map();

export function setRequestHandler(handler) {
  requestHandler = handler;
}

export function startServer(port) {
  if (nativePort) {
    return Promise.resolve({ ok: false, error: 'Server is already running.' });
  }

  chrome.storage.local.set({ serverStatus: 'STARTING', serverError: null });

  return new Promise((resolve) => {
    let settled = false;
    let port_;
    try {
      port_ = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      const message = err.message || String(err);
      chrome.storage.local.set({ serverStatus: 'ERROR', serverError: message });
      resolve({ ok: false, error: message });
      return;
    }

    port_.onMessage.addListener((message) => {
      if (!message) return;

      if (message.type === 'ready') {
        nativePort = port_;
        settled = true;
        chrome.storage.local.set({ serverStatus: 'RUNNING', serverError: null, serverPort: message.port });
        resolve({ ok: true, port: message.port });
        return;
      }

      if (message.type === 'error') {
        settled = true;
        const errText =
          message.code === 'EADDRINUSE'
            ? `Port ${message.port} is already in use. Choose a different port.`
            : message.message || 'Failed to start the local server.';
        chrome.storage.local.set({ serverStatus: 'ERROR', serverError: errText });
        resolve({ ok: false, error: errText });
        try {
          port_.disconnect();
        } catch (err) {
          // already gone; ignore
        }
        return;
      }

      if (message.type === 'request') {
        handleExternalRequest(port_, message);
        return;
      }

      if (message.type === 'cancel') {
        const controller = abortControllers.get(message.id);
        if (controller) controller.abort();
      }
    });

    port_.onDisconnect.addListener(() => {
      nativePort = null;
      if (!settled) {
        settled = true;
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'The native host disconnected unexpectedly.';
        chrome.storage.local.set({ serverStatus: 'ERROR', serverError: err });
        resolve({ ok: false, error: err });
      } else {
        chrome.storage.local.set({ serverStatus: 'STOPPED', serverError: null });
      }
    });

    port_.postMessage({ type: 'start', port });
  });
}

export async function stopServer() {
  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch (err) {
      // already disconnected; ignore
    }
    nativePort = null;
  }
  await chrome.storage.local.set({ serverStatus: 'STOPPED', serverError: null });
  return { ok: true };
}

function handleExternalRequest(port_, message) {
  if (!requestHandler) return;
  const controller = new AbortController();
  abortControllers.set(message.id, controller);

  const normalizedMessage = {
    id: message.id,
    url: `http://127.0.0.1${message.path}`,
    method: message.method,
    body: message.body,
    pageUrl: message.client || 'unknown',
    source: 'external',
  };

  requestHandler(port_, normalizedMessage, controller.signal, () => controller.signal.aborted).finally(() => {
    abortControllers.delete(message.id);
  });
}

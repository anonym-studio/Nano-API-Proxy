// Runs in the page's ISOLATED world (see manifest registration in background/service-worker.js).
// Bridges CustomEvents from scripts/interceptor.js (MAIN world) to the extension service worker
// over a chrome.runtime.connect Port, one Port per intercepted request. Disconnecting the port
// is how request cancellation (AbortSignal) is communicated to the background.
(function () {
  if (window.__nanoApiProxyRelayInstalled) return;
  window.__nanoApiProxyRelayInstalled = true;

  const CONFIG_EVENT = 'nano-api-proxy:config';
  const REQUEST_EVENT = 'nano-api-proxy:request';
  const RESPONSE_START_EVENT = 'nano-api-proxy:response-start';
  const CHUNK_EVENT = 'nano-api-proxy:chunk';
  const RESPONSE_END_EVENT = 'nano-api-proxy:response-end';
  const RESPONSE_ERROR_EVENT = 'nano-api-proxy:response-error';
  const CANCEL_EVENT = 'nano-api-proxy:cancel';
  const PORT_NAME = 'nano-api-proxy:intercept';

  const activePorts = new Map();

  function dispatchToPage(eventName, detail) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(detail) }));
  }

  async function loadConfig() {
    const stored = await chrome.storage.local.get(['interceptEnabled']);
    return { enabled: stored.interceptEnabled !== false };
  }

  async function sendConfig() {
    const config = await loadConfig();
    dispatchToPage(CONFIG_EVENT, config);
  }

  sendConfig();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.interceptEnabled) {
      sendConfig();
    }
  });

  window.addEventListener(REQUEST_EVENT, (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    const { id } = payload;

    let port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      dispatchToPage(RESPONSE_ERROR_EVENT, {
        id,
        message: 'nano-api-proxy: failed to connect to the extension background (is it enabled?)',
      });
      return;
    }
    activePorts.set(id, port);

    port.onMessage.addListener((message) => {
      if (!message || message.id !== id) return;
      switch (message.type) {
        case 'response_start':
          dispatchToPage(RESPONSE_START_EVENT, { id, status: message.status, headers: message.headers });
          break;
        case 'chunk':
          dispatchToPage(CHUNK_EVENT, { id, data: message.data });
          break;
        case 'response_end':
          dispatchToPage(RESPONSE_END_EVENT, { id });
          closePort(id);
          break;
        case 'error':
          dispatchToPage(RESPONSE_ERROR_EVENT, { id, message: message.message });
          closePort(id);
          break;
        default:
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      activePorts.delete(id);
    });

    port.postMessage({
      type: 'request',
      id,
      url: payload.url,
      method: payload.method,
      headers: payload.headers,
      body: payload.body,
      pageUrl: window.location.href,
    });
  });

  window.addEventListener(CANCEL_EVENT, (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    closePort(payload.id);
  });

  function closePort(id) {
    const port = activePorts.get(id);
    if (!port) return;
    activePorts.delete(id);
    try {
      port.disconnect();
    } catch (err) {
      // already disconnected; ignore
    }
  }
})();

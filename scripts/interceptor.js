// Runs in the page's MAIN world (see manifest registration in background/service-worker.js).
// Wraps window.fetch so requests matching a known LLM API endpoint shape are answered locally
// instead of going out over the network. Bridges to scripts/relay.js (ISOLATED world) via
// CustomEvent, since MAIN world scripts have no access to chrome.* APIs.
(function () {
  if (window.__nanoApiProxyInterceptorInstalled) return;
  window.__nanoApiProxyInterceptorInstalled = true;

  const CONFIG_EVENT = 'nano-api-proxy:config';
  const REQUEST_EVENT = 'nano-api-proxy:request';
  const RESPONSE_START_EVENT = 'nano-api-proxy:response-start';
  const CHUNK_EVENT = 'nano-api-proxy:chunk';
  const RESPONSE_END_EVENT = 'nano-api-proxy:response-end';
  const RESPONSE_ERROR_EVENT = 'nano-api-proxy:response-error';
  const CANCEL_EVENT = 'nano-api-proxy:cancel';
  const CONFIG_WAIT_TIMEOUT_MS = 200;

  // Endpoint shapes this extension knows how to emulate (spec §3.2). Duplicated (not imported)
  // from lib/endpoints.js because MAIN-world content scripts run in the page's origin and cannot
  // reliably import extension-page modules without extra web_accessible_resources plumbing.
  const ENDPOINT_PATTERNS = [
    { method: 'POST', pattern: /\/v1\/chat\/completions$/ },
    { method: 'POST', pattern: /\/v1\/messages$/ },
    { method: 'POST', pattern: /\/models\/[^/]+:(streamGenerateContent|generateContent)$/ },
    { method: 'GET', pattern: /\/v1\/models$/ },
  ];

  const originalFetch = window.fetch.bind(window);

  let config = { enabled: false };
  let configReceived = false;
  let configWaiters = [];

  window.addEventListener(CONFIG_EVENT, (event) => {
    const payload = parseDetail(event.detail);
    if (!payload) return;
    config = payload;
    configReceived = true;
    const waiters = configWaiters;
    configWaiters = [];
    waiters.forEach((resolve) => resolve());
  });

  function parseDetail(detail) {
    try {
      return JSON.parse(detail);
    } catch (err) {
      return null;
    }
  }

  function waitForConfig(timeoutMs) {
    if (configReceived) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      configWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function matchesTargetEndpoint(method, url) {
    let pathname;
    try {
      pathname = new URL(url, window.location.href).pathname;
    } catch (err) {
      return false;
    }
    const upperMethod = method.toUpperCase();
    return ENDPOINT_PATTERNS.some((entry) => entry.method === upperMethod && entry.pattern.test(pathname));
  }

  function generateRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function headersToObject(headers) {
    const result = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  async function readBodyAsText(request) {
    if (!request.body) return null;
    return request.clone().text();
  }

  // Wires up the ReadableStream that becomes the fetch() Response body, and the event
  // listeners that feed it from relay.js. One request id maps to exactly one of these.
  function createProxiedResponse(id, signal) {
    let controllerRef = null;
    let responseResolve;
    let responseReject;
    const responseInfoPromise = new Promise((resolve, reject) => {
      responseResolve = resolve;
      responseReject = reject;
    });

    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
      },
      cancel() {
        dispatch(CANCEL_EVENT, { id });
      },
    });

    function onStart(event) {
      const payload = parseDetail(event.detail);
      if (!payload || payload.id !== id) return;
      window.removeEventListener(RESPONSE_START_EVENT, onStart);
      responseResolve({ status: payload.status, headers: payload.headers || {} });
    }

    function onChunk(event) {
      const payload = parseDetail(event.detail);
      if (!payload || payload.id !== id) return;
      controllerRef.enqueue(new TextEncoder().encode(payload.data));
    }

    function onEnd(event) {
      const payload = parseDetail(event.detail);
      if (!payload || payload.id !== id) return;
      try {
        controllerRef.close();
      } catch (err) {
        // already closed/errored; ignore
      }
      cleanup();
    }

    function onError(event) {
      const payload = parseDetail(event.detail);
      if (!payload || payload.id !== id) return;
      const error = new Error(payload.message || 'nano-api-proxy: request failed');
      try {
        controllerRef.error(error);
      } catch (err) {
        // stream may not have a controller yet; response promise rejection covers this case
      }
      responseReject(error);
      cleanup();
    }

    function onAbort() {
      dispatch(CANCEL_EVENT, { id });
      const error = new DOMException('The user aborted a request.', 'AbortError');
      if (controllerRef) {
        try {
          controllerRef.error(error);
        } catch (err) {
          // ignore
        }
      }
      responseReject(error);
      cleanup();
    }

    function cleanup() {
      window.removeEventListener(RESPONSE_START_EVENT, onStart);
      window.removeEventListener(CHUNK_EVENT, onChunk);
      window.removeEventListener(RESPONSE_END_EVENT, onEnd);
      window.removeEventListener(RESPONSE_ERROR_EVENT, onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    window.addEventListener(RESPONSE_START_EVENT, onStart);
    window.addEventListener(CHUNK_EVENT, onChunk);
    window.addEventListener(RESPONSE_END_EVENT, onEnd);
    window.addEventListener(RESPONSE_ERROR_EVENT, onError);
    if (signal) {
      if (signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // responseInfoPromise rejecting before the stream had any bytes is what surfaces the
    // failure to the page's fetch() caller as a rejected promise (matching network-error semantics).
    responseInfoPromise.catch(() => {});

    return { stream, responseInfoPromise };
  }

  function dispatch(eventName, detail) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(detail) }));
  }

  window.fetch = async function nanoApiProxyFetch(input, init = {}) {
    const request = input instanceof Request ? input : new Request(input, init);
    const method = (init && init.method) || request.method || 'GET';
    const url = request.url;

    await waitForConfig(CONFIG_WAIT_TIMEOUT_MS);

    if (!config.enabled || !matchesTargetEndpoint(method, url)) {
      return originalFetch(input, init);
    }

    const id = generateRequestId();
    const headers = headersToObject(request.headers);
    const body = await readBodyAsText(request);
    const signal = (init && init.signal) || request.signal;

    const { stream, responseInfoPromise } = createProxiedResponse(id, signal);

    dispatch(REQUEST_EVENT, { id, url, method, headers, body });

    const { status, headers: responseHeaders } = await responseInfoPromise;
    return new Response(stream, { status, headers: responseHeaders });
  };
})();

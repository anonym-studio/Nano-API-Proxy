// In-memory + chrome.storage.session-backed ring buffer of request log entries, broadcast in
// real time to any connected side panel (spec §3.3). The service worker can be killed and
// restarted between requests, so state is restored from session storage on module load.
const MAX_ENTRIES = 200;
const STORAGE_KEY = 'activityLog';

const entries = [];
const sidePanelPorts = new Set();

export async function restoreFromSession() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    if (Array.isArray(stored[STORAGE_KEY])) {
      entries.splice(0, entries.length, ...stored[STORAGE_KEY]);
    }
  } catch (err) {
    // chrome.storage.session unavailable; log just won't survive a service worker restart.
  }
}

export function attachSidePanelPort(port) {
  sidePanelPorts.add(port);
  port.postMessage({ type: 'log:init', entries });
  port.onDisconnect.addListener(() => sidePanelPorts.delete(port));
}

function persist() {
  chrome.storage.session.set({ [STORAGE_KEY]: entries }).catch(() => {});
}

function broadcast(message) {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(message);
    } catch (err) {
      sidePanelPorts.delete(port);
    }
  }
}

function truncate(text, maxLength) {
  if (typeof text !== 'string') return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// `source` is 'in-browser' (Mode A) or 'external' (Mode B, added in Phase 3).
export function createLogEntry({ id, source, method, url, origin, messagesPreview }) {
  const entry = {
    id,
    source,
    method,
    url,
    origin,
    messagesPreview: Array.isArray(messagesPreview)
      ? messagesPreview.map((m) => ({ role: m.role, content: truncate(m.content, 300) }))
      : [],
    status: 'Streaming...',
    startedAt: Date.now(),
    ttftMs: null,
    completedAt: null,
    responsePreview: '',
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  broadcast({ type: 'log:add', entry });
  persist();
  return entry;
}

export function markFirstToken(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.ttftMs !== null) return;
  const patch = { ttftMs: Date.now() - entry.startedAt };
  Object.assign(entry, patch);
  broadcast({ type: 'log:update', id, patch });
}

export function completeLogEntry(id, { status, responseText }) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const patch = {
    status,
    completedAt: Date.now(),
    responsePreview: truncate(responseText || '', 500),
  };
  Object.assign(entry, patch);
  broadcast({ type: 'log:update', id, patch });
  persist();
}

export function clearLog() {
  entries.length = 0;
  broadcast({ type: 'log:clear' });
  persist();
}

// Side panel controller (spec §4). Availability + model download talk to `LanguageModel`
// directly (this page is a Document context with its own user-activation, unlike the service
// worker — spec §5 item 6). Everything else (intercept toggle, server control, settings, activity
// log) goes through chrome.storage / messages to background/service-worker.js.

const aiStatusEl = document.getElementById('ai-status');
const downloadBtn = document.getElementById('download-btn');
const downloadProgressRow = document.getElementById('download-progress-row');
const downloadProgressEl = document.getElementById('download-progress');
const downloadProgressLabel = document.getElementById('download-progress-label');

const interceptToggle = document.getElementById('intercept-toggle');
const interceptTargetsHint = document.getElementById('intercept-targets');

const serverStatusEl = document.getElementById('server-status');
const serverPortInput = document.getElementById('server-port');
const serverStartBtn = document.getElementById('server-start-btn');
const serverStopBtn = document.getElementById('server-stop-btn');
const serverErrorEl = document.getElementById('server-error');

const logListEl = document.getElementById('log-list');
const logEmptyEl = document.getElementById('log-empty');
const logFilterEl = document.getElementById('log-filter');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const logItemTemplate = document.getElementById('log-item-template');

const systemPromptOverrideEl = document.getElementById('system-prompt-override');
const latencyTtftEl = document.getElementById('latency-ttft');
const latencyJitterEl = document.getElementById('latency-jitter');
const interceptTargetsInput = document.getElementById('intercept-targets-input');
const saveTargetsBtn = document.getElementById('save-targets-btn');

const DEFAULT_TARGETS = ['http://localhost/*', 'http://127.0.0.1/*'];

let logEntries = [];
let currentFilter = 'all';

// ---- Built-in AI availability -------------------------------------------------------------

async function refreshAvailability() {
  if (typeof LanguageModel === 'undefined') {
    setAvailabilityBadge('unsupported');
    return;
  }
  try {
    const availability = await LanguageModel.availability();
    setAvailabilityBadge(availability);
  } catch (err) {
    setAvailabilityBadge('unavailable');
  }
}

function setAvailabilityBadge(status) {
  aiStatusEl.textContent = status.toUpperCase();
  aiStatusEl.className = `badge badge-${status}`;
  downloadBtn.classList.toggle('hidden', status !== 'downloadable');
}

downloadBtn.addEventListener('click', async () => {
  if (typeof LanguageModel === 'undefined') return;
  downloadBtn.disabled = true;
  downloadProgressRow.classList.remove('hidden');
  try {
    const session = await LanguageModel.create({
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const percent = Math.round((event.loaded || 0) * 100);
          downloadProgressEl.value = percent;
          downloadProgressLabel.textContent = `${percent}%`;
        });
      },
    });
    // The download is browser-wide; this session only exists to trigger it.
    session.destroy();
  } catch (err) {
    serverErrorEl.textContent = `モデルのダウンロードに失敗しました: ${err.message || err}`;
    serverErrorEl.classList.remove('hidden');
  } finally {
    downloadBtn.disabled = false;
    downloadProgressRow.classList.add('hidden');
    refreshAvailability();
  }
});

// ---- Intercept toggle -----------------------------------------------------------------------

async function loadInterceptState() {
  const stored = await chrome.storage.local.get(['interceptEnabled', 'interceptTargets']);
  interceptToggle.checked = stored.interceptEnabled !== false;
  const targets = Array.isArray(stored.interceptTargets) ? stored.interceptTargets : DEFAULT_TARGETS;
  interceptTargetsHint.textContent = targets.join(', ');
  interceptTargetsInput.value = targets.join('\n');
}

interceptToggle.addEventListener('change', () => {
  chrome.storage.local.set({ interceptEnabled: interceptToggle.checked });
});

saveTargetsBtn.addEventListener('click', () => {
  const targets = interceptTargetsInput.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  chrome.storage.local.set({ interceptTargets: targets.length > 0 ? targets : DEFAULT_TARGETS });
});

// ---- Local server control (Phase 3 wires the real behavior into service-worker.js) ----------

async function loadServerState() {
  const stored = await chrome.storage.local.get(['serverStatus', 'serverError', 'serverPort']);
  renderServerState(stored.serverStatus || 'STOPPED', stored.serverError);
  if (stored.serverPort) serverPortInput.value = stored.serverPort;
}

function renderServerState(status, errorMessage) {
  serverStatusEl.textContent = status;
  serverStatusEl.className = `badge badge-${status.toLowerCase()}`;
  const running = status === 'RUNNING';
  serverStartBtn.classList.toggle('hidden', running || status === 'STARTING');
  serverStopBtn.classList.toggle('hidden', !running && status !== 'STARTING');
  serverErrorEl.classList.toggle('hidden', !errorMessage);
  serverErrorEl.textContent = errorMessage || '';
}

serverStartBtn.addEventListener('click', async () => {
  const port = Number(serverPortInput.value) || 8080;
  await chrome.storage.local.set({ serverPort: port });
  renderServerState('STARTING');
  await chrome.runtime.sendMessage({ type: 'server:start', port });
});

serverStopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'server:stop' });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.serverStatus || changes.serverError) {
    chrome.storage.local.get(['serverStatus', 'serverError']).then((stored) => {
      renderServerState(stored.serverStatus || 'STOPPED', stored.serverError);
    });
  }
});

// ---- Settings ---------------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get(['systemPromptOverride', 'latencyTtftMs', 'latencyJitterMs']);
  systemPromptOverrideEl.value = stored.systemPromptOverride || '';
  latencyTtftEl.value = stored.latencyTtftMs || 0;
  latencyJitterEl.value = stored.latencyJitterMs || 0;
}

systemPromptOverrideEl.addEventListener('change', () => {
  chrome.storage.local.set({ systemPromptOverride: systemPromptOverrideEl.value });
});
latencyTtftEl.addEventListener('change', () => {
  chrome.storage.local.set({ latencyTtftMs: Number(latencyTtftEl.value) || 0 });
});
latencyJitterEl.addEventListener('change', () => {
  chrome.storage.local.set({ latencyJitterMs: Number(latencyJitterEl.value) || 0 });
});

// ---- Tabs -------------------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- Activity log -------------------------------------------------------------------------------

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false });
}

function renderLog() {
  logListEl.innerHTML = '';
  const visible = logEntries.filter((e) => currentFilter === 'all' || e.source === currentFilter);
  logEmptyEl.classList.toggle('hidden', visible.length > 0);

  for (const entry of visible) {
    const node = logItemTemplate.content.cloneNode(true);
    const sourceBadge = node.querySelector('.source-badge');
    sourceBadge.textContent = entry.source === 'in-browser' ? 'IN-BROWSER' : 'EXTERNAL-HTTP';
    sourceBadge.classList.add(entry.source === 'in-browser' ? 'source-in-browser' : 'source-external');

    node.querySelector('.method').textContent = entry.method;
    node.querySelector('.url').textContent = entry.url;
    node.querySelector('.status').textContent = entry.status;
    node.querySelector('.ttft').textContent = entry.ttftMs !== null ? `TTFT: ${entry.ttftMs}ms` : '';

    node.querySelector('.log-origin').textContent = `[${formatTime(entry.startedAt)}] ${entry.origin || ''}`;
    node.querySelector('.log-messages').textContent = entry.messagesPreview
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
    node.querySelector('.log-response').textContent = entry.responsePreview || '';

    const summaryBtn = node.querySelector('.log-summary');
    const detail = node.querySelector('.log-detail');
    summaryBtn.addEventListener('click', () => detail.classList.toggle('hidden'));

    logListEl.appendChild(node);
  }
}

logFilterEl.addEventListener('change', () => {
  currentFilter = logFilterEl.value;
  renderLog();
});

clearLogsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'log:clear' });
});

function connectLogPort() {
  const port = chrome.runtime.connect({ name: 'nano-api-proxy:sidepanel' });
  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'log:init') {
      logEntries = message.entries;
      renderLog();
    } else if (message.type === 'log:add') {
      logEntries.unshift(message.entry);
      if (logEntries.length > 200) logEntries.length = 200;
      renderLog();
    } else if (message.type === 'log:update') {
      const entry = logEntries.find((e) => e.id === message.id);
      if (entry) Object.assign(entry, message.patch);
      renderLog();
    } else if (message.type === 'log:clear') {
      logEntries = [];
      renderLog();
    }
  });
  port.onDisconnect.addListener(() => {
    // Service worker was recycled; reconnect so the log keeps streaming live.
    setTimeout(connectLogPort, 500);
  });
}

// ---- Init ---------------------------------------------------------------------------------------

refreshAvailability();
loadInterceptState();
loadServerState();
loadSettings();
connectLogPort();

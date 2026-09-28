// Test-only demo app for exercising Nano API Proxy's Mode A (in-browser fetch interception).
// Every request below targets a real vendor hostname; when the extension is loaded and
// Intercept is ON for this page's origin, none of it ever reaches the network — the extension's
// interceptor.js answers it locally with Gemini Nano output instead. If interception is off (or
// the extension isn't installed), these calls fail as ordinary network/CORS errors against a
// dummy API key, which is itself a useful signal that interception isn't active.

const vendorSelect = document.getElementById('vendor');
const modelInput = document.getElementById('model');
const streamCheckbox = document.getElementById('stream');
const systemPromptInput = document.getElementById('system-prompt');
const chatLog = document.getElementById('chat-log');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const statusText = document.getElementById('status-text');
const clearBtn = document.getElementById('clear-btn');
const rawRequestEl = document.getElementById('raw-request');
const rawResponseEl = document.getElementById('raw-response');

const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-1.5-flash',
};

let history = []; // [{ role: 'user' | 'assistant', content: string }]
let sending = false;

vendorSelect.addEventListener('change', () => {
  modelInput.value = DEFAULT_MODELS[vendorSelect.value];
});

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function buildRequest(vendor, { model, stream, systemPrompt, userText }) {
  if (vendor === 'openai') {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const m of history) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: userText });
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
      body: { model, stream, messages },
    };
  }

  if (vendor === 'anthropic') {
    const messages = [];
    for (const m of history) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: userText });
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy', 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: 1024, stream, ...(systemPrompt ? { system: systemPrompt } : {}), messages },
    };
  }

  if (vendor === 'gemini') {
    const contents = [];
    for (const m of history) {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
    contents.push({ role: 'user', parts: [{ text: userText }] });
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}?key=dummy`,
      headers: { 'Content-Type': 'application/json' },
      body: { contents, ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}) },
    };
  }

  throw new Error(`unknown vendor: ${vendor}`);
}

function extractFullText(vendor, json) {
  if (vendor === 'openai') return json.choices?.[0]?.message?.content || '';
  if (vendor === 'anthropic') return json.content?.[0]?.text || '';
  if (vendor === 'gemini') return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return '';
}

function extractDelta(vendor, eventName, obj) {
  if (vendor === 'openai') return obj.choices?.[0]?.delta?.content || '';
  if (vendor === 'anthropic') return eventName === 'content_block_delta' ? obj.delta?.text || '' : '';
  if (vendor === 'gemini') return obj.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return '';
}

// Splits a Server-Sent Events byte stream into frames and pulls out the text delta each vendor
// puts in a different place. Anthropic frames carry an `event:` line; OpenAI/Gemini don't.
async function streamResponse(response, vendor, onDelta, onRawChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    onRawChunk(text);
    buffer += text;

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = null;
      const dataLines = [];
      for (const line of rawFrame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') continue;

      let obj;
      try {
        obj = JSON.parse(data);
      } catch (err) {
        continue;
      }
      const delta = extractDelta(vendor, eventName, obj);
      if (delta) onDelta(delta);
    }
  }
}

async function sendMessage() {
  if (sending) return;
  const userText = userInput.value.trim();
  if (!userText) return;

  sending = true;
  sendBtn.disabled = true;
  userInput.value = '';
  appendMessage('user', userText);

  const vendor = vendorSelect.value;
  const model = modelInput.value.trim() || DEFAULT_MODELS[vendor];
  const stream = streamCheckbox.checked;
  const systemPrompt = systemPromptInput.value.trim();

  const request = buildRequest(vendor, { model, stream, systemPrompt, userText });
  rawRequestEl.textContent = `${request.url}\n\n${JSON.stringify(request.body, null, 2)}`;
  rawResponseEl.textContent = '';

  const startedAt = performance.now();
  let ttftMs = null;
  const assistantEl = appendMessage('assistant', '');
  let fullText = '';
  let rawAccumulated = '';

  statusText.textContent = 'Sending…';

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });

    if (!response.ok && !stream) {
      const errorBody = await response.text();
      rawResponseEl.textContent = errorBody;
      throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
    }

    if (stream) {
      await streamResponse(
        response,
        vendor,
        (delta) => {
          if (ttftMs === null) {
            ttftMs = Math.round(performance.now() - startedAt);
            statusText.textContent = `TTFT: ${ttftMs}ms`;
          }
          fullText += delta;
          assistantEl.textContent = fullText;
          chatLog.scrollTop = chatLog.scrollHeight;
        },
        (rawChunk) => {
          rawAccumulated += rawChunk;
          rawResponseEl.textContent = rawAccumulated;
        }
      );
    } else {
      const json = await response.json();
      rawResponseEl.textContent = JSON.stringify(json, null, 2);
      fullText = extractFullText(vendor, json);
      assistantEl.textContent = fullText;
      ttftMs = Math.round(performance.now() - startedAt);
    }

    const totalMs = Math.round(performance.now() - startedAt);
    statusText.textContent = ttftMs !== null ? `TTFT: ${ttftMs}ms / Total: ${totalMs}ms` : `Total: ${totalMs}ms`;

    if (fullText) {
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: fullText });
    }
  } catch (err) {
    assistantEl.remove();
    appendMessage(
      'error',
      `リクエストに失敗しました: ${err.message}\n\n` +
        '拡張機能が読み込まれているか、Intercept が ON になっているか、' +
        'このページのオリジンが対象オリジンに含まれているか確認してください。'
    );
    statusText.textContent = 'Error';
  } finally {
    sending = false;
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

clearBtn.addEventListener('click', () => {
  history = [];
  chatLog.innerHTML = '';
  rawRequestEl.textContent = '';
  rawResponseEl.textContent = '';
  statusText.textContent = 'Ready';
});

modelInput.value = DEFAULT_MODELS[vendorSelect.value];

// Thin wrapper around Chrome's built-in Prompt API (`LanguageModel`, Chrome 138+). This module
// only works in a context where `LanguageModel` is actually defined (an extension page/service
// worker on a supporting Chrome build). background/inference-router.js decides whether to call
// this directly or delegate to the offscreen-document fallback (spec §5, item 5).
export async function checkAvailability(options) {
  if (typeof LanguageModel === 'undefined') {
    return 'unsupported';
  }
  try {
    return await LanguageModel.availability(options);
  } catch (err) {
    return 'unavailable';
  }
}

// Splits normalized OpenAI-style messages into Prompt API `initialPrompts` (system + prior
// turns) plus the single trailing user message that becomes the live `promptStreaming` input.
// initialPrompts requires "system" first if present (spec §3.2 mapping table).
function buildInitialPrompts(messages) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const conversational = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  let lastUserIndex = -1;
  for (let i = conversational.length - 1; i >= 0; i -= 1) {
    if (conversational[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const history = lastUserIndex >= 0 ? conversational.slice(0, lastUserIndex) : conversational;
  const lastUserMessage = lastUserIndex >= 0 ? conversational[lastUserIndex].content : '';

  const initialPrompts = [];
  if (systemParts.length > 0) {
    initialPrompts.push({ role: 'system', content: systemParts.join('\n\n') });
  }
  for (const message of history) {
    initialPrompts.push({ role: message.role, content: message.content });
  }

  return { initialPrompts, lastUserMessage };
}

// temperature/topK are extension-only Prompt API features and must stay within
// LanguageModel.params() bounds, which vary by device/model build.
async function clampSamplingParams({ temperature, topK }) {
  const clamped = { temperature, topK };
  if (typeof LanguageModel.params !== 'function') return clamped;
  try {
    const limits = await LanguageModel.params();
    if (limits) {
      if (typeof clamped.temperature === 'number' && typeof limits.maxTemperature === 'number') {
        clamped.temperature = Math.min(clamped.temperature, limits.maxTemperature);
      }
      if (typeof clamped.topK === 'number' && typeof limits.maxTopK === 'number') {
        clamped.topK = Math.min(clamped.topK, limits.maxTopK);
      }
    }
  } catch (err) {
    // params() unsupported on this build; fall through with unclamped values.
  }
  return clamped;
}

// Async generator yielding text deltas (promptStreaming chunks are incremental, not
// cumulative). Creates and destroys one session per call so requests are fully isolated.
export async function* runChatCompletion(normalized, signal) {
  const { initialPrompts, lastUserMessage } = buildInitialPrompts(normalized.messages);
  const sampling = await clampSamplingParams({
    temperature: normalized.temperature,
    topK: normalized.topK,
  });

  const createOptions = { initialPrompts, signal };
  if (typeof sampling.temperature === 'number') createOptions.temperature = sampling.temperature;
  if (typeof sampling.topK === 'number') createOptions.topK = sampling.topK;
  if (normalized.responseConstraint) createOptions.responseConstraint = normalized.responseConstraint;

  const session = await LanguageModel.create(createOptions);
  try {
    const stream = session.promptStreaming(lastUserMessage, { signal });
    for await (const chunk of stream) {
      yield chunk;
    }
  } finally {
    session.destroy();
  }
}

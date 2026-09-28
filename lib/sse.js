// Shared Server-Sent Events framing helpers, reused by every vendor adapter in lib/adapters/.
export function formatSSE(dataObj) {
  return `data: ${JSON.stringify(dataObj)}\n\n`;
}

// Anthropic's Messages API streams named events (`event: message_start`, etc.); OpenAI and
// Gemini only ever send bare `data:` frames (formatSSE above).
export function formatNamedSSE(eventName, dataObj) {
  return `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

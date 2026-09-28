// Shared Server-Sent Events framing helpers, reused by every vendor adapter in lib/adapters/.
export function formatSSE(dataObj) {
  return `data: ${JSON.stringify(dataObj)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

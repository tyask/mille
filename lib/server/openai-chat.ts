export const openAIChatEndpoint = "https://api.openai.com/v1/chat/completions";
export const openAIApiKeyPattern = /^sk-[A-Za-z0-9_-]{1,4093}$/u;
export const openAIRequestIdPattern = /^req_[A-Za-z0-9_-]{1,96}$/u;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readChatResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return parseJson(text + decoder.decode());
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function consumeSseStream(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        onData(JSON.parse(data));
      } catch (_) {}
    }
  }

  if (buffer.trim()) {
    const line = buffer.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          onData(JSON.parse(data));
        } catch (_) {}
      }
    }
  }
}

export function parseModelSelection(selection) {
  if (!selection) return ["OpenAI", "gpt-5.4-nano"];
  const idx = selection.indexOf(":");
  if (idx === -1) return ["OpenAI", selection];
  return [selection.slice(0, idx), selection.slice(idx + 1)];
}

export function getModelConfig(providerInfo, modelName) {
  return (providerInfo.models || []).find((m) => m.name === modelName) || null;
}

export function getReasoningEffort(providerInfo, modelName, reasoningLevel) {
  const modelInfo = getModelConfig(providerInfo, modelName);
  if (!modelInfo) return null;

  const values =
    modelInfo.reasoning_effort ??
    modelInfo.reasoningEffort ??
    providerInfo.reasoning_effort ??
    providerInfo.reasoningEffort;

  if (!Array.isArray(values)) return null;

  const idx = parseInt(reasoningLevel, 10);
  if (isNaN(idx) || idx < 0 || idx >= values.length) return null;

  return values[idx];
}

export function getProviderType(providerName, providerInfo) {
  if (providerInfo.type) return providerInfo.type;

  const name = providerName.toLowerCase();
  const base = String(providerInfo.base_url || providerInfo.baseUrl || "").toLowerCase();

  if (name.includes("anthropic") || base.includes("anthropic.com")) return "anthropic";
  if (
    name.includes("google") ||
    name.includes("gemini") ||
    base.includes("generativelanguage")
  ) {
    return "google";
  }
  return "openai";
}


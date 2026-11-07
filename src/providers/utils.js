export async function consumeSseStream(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  function consumeLine(line) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      return;
    }
    // Provider errors must propagate instead of being treated as invalid JSON.
    onData(json);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch (_) {}
    reader.releaseLock();
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
  const explicitType = String(providerInfo.type ?? "").trim().toLowerCase();
  if (explicitType) {
    if (["anthropic", "google", "openai"].includes(explicitType)) return explicitType;
    throw new Error(`Unsupported provider type: ${explicitType}. Use anthropic, google or openai.`);
  }

  const name = providerName.toLowerCase();
  const base = String(providerInfo.base_url || providerInfo.baseUrl || "").toLowerCase();

  if (name.includes("anthropic") || name.includes("claude") || base.includes("anthropic.com")) {
    return "anthropic";
  }
  if (
    name.includes("google") ||
    name.includes("gemini") ||
    base.includes("generativelanguage")
  ) {
    return "google";
  }
  return "openai";
}

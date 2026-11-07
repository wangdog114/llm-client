import { consumeSseStream, getReasoningEffort } from "./utils.js";

export async function createAnthropicCompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel,
  env
) {
  const apiKey =
    modelInfo?.api_key ||
    modelInfo?.apiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for Anthropic provider.");

  const endpoint = new URL(String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.anthropic.com"
  ).trim());
  const path = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = path.endsWith("/v1/messages")
    ? path
    : path.endsWith("/v1")
      ? `${path}/messages`
      : `${path}/v1/messages`;

  const messages = [];
  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.raw_content || m.content });
    }
  }
  messages.push({ role: "user", content: userText });

  const maxTokens = Number(
    modelInfo?.max_tokens ??
    providerInfo.max_tokens ??
    env?.ANTHROPIC_MAX_TOKENS ??
    4096
  );
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("Anthropic max_tokens must be a positive integer.");
  }

  const body = {
    model: modelName,
    max_tokens: maxTokens,
    messages,
  };

  if (systemPrompt) body.system = [{ type: "text", text: systemPrompt }];

  const reasoningEffort = getReasoningEffort(providerInfo, modelName, reasoningLevel);
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.output_config = { effort: reasoningEffort };
  }

  body.stream = true;

  const resp = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errorText}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType && contentType.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
    await resp.body?.cancel();
    throw new Error(
      `Anthropic expected text/event-stream but received ${contentType}. Check provider type and base_url.`
    );
  }
  if (!resp.body) throw new Error("Anthropic returned an empty response body.");

  let finalText = "";
  let usage = null;
  let messageStopped = false;
  let stopReason = null;
  let tokenUsage = {};

  function updateUsage(nextUsage) {
    if (!nextUsage) return;
    // Delta usage is cumulative and can omit fields supplied at message_start.
    tokenUsage = { ...tokenUsage, ...nextUsage };
    const prompt =
      (tokenUsage.input_tokens ?? 0) +
      (tokenUsage.cache_creation_input_tokens ?? 0) +
      (tokenUsage.cache_read_input_tokens ?? 0);
    const completion = tokenUsage.output_tokens ?? 0;
    usage = { prompt, completion, total: prompt + completion };
  }

  await consumeSseStream(resp.body, (json) => {
    if (json.type === "error") {
      throw new Error(
        `Anthropic stream error: ${json.error?.message || json.error?.type || "Unknown error"}`
      );
    }
    if (json.type === "message_start") {
      updateUsage(json.message?.usage);
      stopReason = json.message?.stop_reason ?? stopReason;
    }
    if (json.type === "content_block_start" && json.content_block?.type === "text") {
      finalText += json.content_block.text || "";
    }
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      finalText += json.delta.text || "";
    }
    if (json.type === "message_delta") {
      updateUsage(json.usage);
      stopReason = json.delta?.stop_reason ?? stopReason;
    }
    if (json.type === "message_stop") {
      messageStopped = true;
    }
  });

  if (!messageStopped) {
    throw new Error("Anthropic stream ended before message_stop.");
  }
  if (!finalText.trim()) {
    throw new Error(
      `Anthropic returned no text (stop_reason: ${stopReason || "unknown"}). Check max_tokens and the upstream response.`
    );
  }

  return { text: finalText, usage };
}

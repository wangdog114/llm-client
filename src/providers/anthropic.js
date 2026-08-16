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

  const baseUrl = String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.anthropic.com"
  ).replace(/\/+$/, "");

  const messages = [];
  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.raw_content || m.content });
    }
  }
  messages.push({ role: "user", content: userText });

  const maxTokens =
    modelInfo?.max_tokens ||
    providerInfo.max_tokens ||
    env?.ANTHROPIC_MAX_TOKENS ||
    8000;

  const body = {
    model: modelName,
    max_tokens: maxTokens,
    messages,
  };

  if (systemPrompt) body.system = systemPrompt;

  const reasoningEffort = getReasoningEffort(providerInfo, modelName, reasoningLevel);
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.output_config = { effort: reasoningEffort };
  }

  body.stream = true;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errorText}`);
  }

  let finalText = "";
  let usage = null;

  await consumeSseStream(resp.body, (json) => {
    if (json.type === "message_start") {
      usage = {
        prompt: json.message?.usage?.input_tokens || 0,
        completion: 0,
        total: 0,
      };
    }
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      finalText += json.delta.text || "";
    }
    if (json.type === "message_delta" && usage) {
      usage.completion = json.usage?.output_tokens || 0;
      usage.total = usage.prompt + usage.completion;
    }
  });

  return { text: finalText, usage };
}


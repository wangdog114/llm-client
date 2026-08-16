import { consumeSseStream, getReasoningEffort } from "./utils.js";

async function createOpenAIResponsesCompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel
) {
  const apiKey =
    modelInfo?.api_key ||
    modelInfo?.apiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for OpenAI-compatible provider.");

  const baseUrl = String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  const webSearchEnabled =
    modelInfo?.web_search ??
    modelInfo?.webSearch ??
    providerInfo.web_search ??
    providerInfo.webSearch ??
    false;

  const input = [];
  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      input.push({ role: m.role, content: m.raw_content || m.content });
    }
  }
  input.push({ role: "user", content: userText });

  const body = { model: modelName, input };
  if (systemPrompt) body.instructions = systemPrompt;
  if (webSearchEnabled) body.tools = [{ type: "web_search" }];

  const reasoningEffort = getReasoningEffort(providerInfo, modelName, reasoningLevel);
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.reasoning = { effort: reasoningEffort };
  }

  body.stream = true;

  const resp = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`OpenAI Responses API error ${resp.status}: ${errorText}`);
  }

  let finalText = "";
  let usage = null;

  await consumeSseStream(resp.body, (json) => {
    if (json.type === "response.output_text.delta") {
      finalText += json.delta || "";
    }
    if (json.type === "response.completed" && json.response?.usage) {
      const u = json.response.usage;
      usage = {
        prompt: u.input_tokens || 0,
        completion: u.output_tokens || 0,
        total: u.total_tokens || 0,
      };
    }
  });

  return { text: finalText, usage };
}

async function createOpenAICompletionsCompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel
) {
  const apiKey =
    modelInfo?.api_key ||
    modelInfo?.apiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for OpenAI-compatible provider.");

  const baseUrl = String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  const messages = [];
  if (systemPrompt) messages.push({ role: "developer", content: systemPrompt });

  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.raw_content || m.content });
    }
  }
  messages.push({ role: "user", content: userText });

  const body = { model: modelName, messages };
  const reasoningEffort = getReasoningEffort(providerInfo, modelName, reasoningLevel);
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.reasoning = { effort: reasoningEffort };
  }

  body.stream = true;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`OpenAI Chat Completions API error ${resp.status}: ${errorText}`);
  }

  let finalText = "";
  let usage = null;

  await consumeSseStream(resp.body, (json) => {
    if (json.usage) {
      const reasoning = json.usage.completion_tokens_details?.reasoning_tokens || 0;
      const completion = (json.usage.completion_tokens || 0) + reasoning;
      usage = {
        prompt: json.usage.prompt_tokens || 0,
        completion,
        total: json.usage.total_tokens || 0,
      };
    }
    const delta = json.choices?.[0]?.delta;
    if (delta && typeof delta.content === "string") {
      finalText += delta.content;
    }
  });

  return { text: finalText, usage };
}

export async function createOpenAICompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel
) {
  const apiType = modelInfo?.api_type || modelInfo?.apiType || "responses";
  if (apiType === "completions" || apiType === "chat") {
    return createOpenAICompletionsCompletion(
      providerInfo,
      modelInfo,
      modelName,
      systemPrompt,
      chatHistory,
      userText,
      reasoningLevel
    );
  }
  return createOpenAIResponsesCompletion(
    providerInfo,
    modelInfo,
    modelName,
    systemPrompt,
    chatHistory,
    userText,
    reasoningLevel
  );
}


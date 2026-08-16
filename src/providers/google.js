import { consumeSseStream } from "./utils.js";

export async function createGoogleGroundedCompletion(
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

  if (!apiKey) throw new Error("No API key for Google provider.");

  const baseUrl = String(
    providerInfo.base_url ||
    providerInfo.baseUrl ||
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");

  const contents = [];
  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.raw_content || m.content }],
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  const body = { contents };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const googleSearch =
    modelInfo?.google_search ??
    modelInfo?.googleSearch ??
    providerInfo.google_search ??
    providerInfo.googleSearch ??
    false;

  if (googleSearch) {
    body.tools = [{ googleSearch: {} }];
  }

  const supportsThinking =
    modelInfo?.supports_thinking ??
    modelInfo?.supportsThinking ??
    providerInfo.supports_thinking ??
    providerInfo.supportsThinking ??
    true;

  body.generationConfig = body.generationConfig || {};
  if (supportsThinking) {
    body.generationConfig.thinkingConfig = {
      includeThoughts: true,
    };
  }

  const genaiModel = modelName.replace(/^models\//, "");
  const url = `${baseUrl}/models/${encodeURIComponent(genaiModel)}:streamGenerateContent?alt=sse`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Google API error ${resp.status}: ${errorText}`);
  }

  let finalText = "";
  let usage = null;

  await consumeSseStream(resp.body, (json) => {
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.text && !part.thought) {
        finalText += part.text;
      }
    }

    if (json.usageMetadata) {
      const prompt = json.usageMetadata.promptTokenCount || 0;
      const completion =
        (json.usageMetadata.candidatesTokenCount || 0) +
        (json.usageMetadata.thoughtsTokenCount || 0);
      usage = {
        prompt,
        completion,
        total: json.usageMetadata.totalTokenCount || prompt + completion,
      };
    }
  });

  return { text: finalText, usage };
}


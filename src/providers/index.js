import { getProviderType } from "./utils.js";
import { createOpenAICompletion } from "./openai.js";
import { createAnthropicCompletion } from "./anthropic.js";
import { createGoogleGroundedCompletion } from "./google.js";

export async function createProviderCompletion(
  providerName,
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel,
  env
) {
  const type = getProviderType(providerName, providerInfo);

  if (type === "anthropic") {
    return createAnthropicCompletion(
      providerInfo,
      modelInfo,
      modelName,
      systemPrompt,
      chatHistory,
      userText,
      reasoningLevel,
      env
    );
  }

  if (type === "google") {
    return createGoogleGroundedCompletion(
      providerInfo,
      modelInfo,
      modelName,
      systemPrompt,
      chatHistory,
      userText,
      reasoningLevel
    );
  }

  return createOpenAICompletion(
    providerInfo,
    modelInfo,
    modelName,
    systemPrompt,
    chatHistory,
    userText,
    reasoningLevel
  );
}


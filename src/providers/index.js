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

  const createCompletion = {
    anthropic: createAnthropicCompletion,
    google: createGoogleGroundedCompletion,
    openai: createOpenAICompletion,
  }[type];
  const result = await createCompletion(
    providerInfo,
    modelInfo,
    modelName,
    systemPrompt,
    chatHistory,
    userText,
    reasoningLevel,
    env
  );
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error(
      `Provider ${providerName} returned an empty text response. Check provider type, base_url and model configuration.`
    );
  }
  return result;
}

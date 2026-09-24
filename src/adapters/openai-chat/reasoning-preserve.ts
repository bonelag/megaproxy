import type { OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";

/**
 * Replay `reasoning_content` for an explicit preserve list, and also for DeepSeek
 * thinking ids that were never written onto a custom provider row. `deepseek-chat`
 * stays out: that id is the non-thinking sibling and a fabricated field is a 400.
 */
export function shouldPreserveReasoningContent(
  provider: OcxProviderConfig,
  modelId: string,
): boolean {
  if (modelInList(provider.preserveReasoningContentModels, modelId)) return true;
  const lower = modelId.toLowerCase();
  if (
    lower.includes("deepseek-reasoner")
    || lower.includes("deepseek-r1")
    || (lower.includes("deepseek") && (lower.includes("reason") || lower.includes("r1") || lower.includes("thinking") || lower.includes("v4")))
  ) {
    return true;
  }
  const providerId = "id" in provider && typeof provider.id === "string" ? provider.id : undefined;
  if (
    provider.adapter === "openai-chat"
    && (provider.baseUrl?.includes("deepseek.com") || providerId === "deepseek")
    && !lower.includes("deepseek-chat")
  ) {
    return true;
  }
  return false;
}

/**
 * A thinking-mode continuation with no recorded reasoning still needs a field, or
 * DeepSeek rejects it. An explicit `requiresReasoningPlaceholderModels: []` opts out
 * (MiniMax low effort); a requires-only custom id that is not on the preserve list
 * also stays out, because this adapter never serializes the field for it.
 */
export function shouldInjectReasoningPlaceholder(
  provider: OcxProviderConfig,
  modelId: string,
): boolean {
  if (Array.isArray(provider.requiresReasoningPlaceholderModels) && !modelInList(provider.requiresReasoningPlaceholderModels, modelId)) {
    return false;
  }
  if (modelInList(provider.requiresReasoningPlaceholderModels ?? provider.preserveReasoningContentModels, modelId)) {
    return true;
  }
  return shouldPreserveReasoningContent(provider, modelId);
}

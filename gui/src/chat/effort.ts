/**
 * Thinking-effort ladder for the Chat tab.
 *
 * The ids are the wire values, not UI labels: `src/chat/inbound.ts` accepts
 * exactly these on `reasoning_effort` and copies them onto the Responses body as
 * `reasoning.effort`, where the routed adapter maps them to whatever the
 * provider speaks (`reasoning_effort`, `reasoning.effort`, `thinking_budget`,
 * `thinking.type`). Renaming a rung here silently drops the effort, so the
 * labels live in i18n and the ids stay wire-shaped.
 *
 * `none` is a real rung, not "unset": it makes the proxy ask for no thinking at
 * all (`reasoning_effort: "none"` on native OpenAI, `reasoning: {enabled:false}`
 * on gateways, omitted elsewhere) rather than inheriting the provider default.
 */
import type { TKey } from "../i18n/shared";

export const CHAT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export const DEFAULT_CHAT_EFFORT: ChatEffort = "low";

/** Icon key for each rung; the page maps these to components. */
export type ChatEffortIcon = "ban" | "bolt" | "brainCog" | "brain" | "sparkles" | "star";

export interface ChatEffortMeta {
  id: ChatEffort;
  tkey: TKey;
  icon: ChatEffortIcon;
}

export const CHAT_EFFORT_META: readonly ChatEffortMeta[] = [
  { id: "none", tkey: "chat.effortNone", icon: "ban" },
  { id: "low", tkey: "chat.effortLow", icon: "bolt" },
  { id: "medium", tkey: "chat.effortMedium", icon: "brainCog" },
  { id: "high", tkey: "chat.effortHigh", icon: "brain" },
  { id: "xhigh", tkey: "chat.effortXhigh", icon: "sparkles" },
  { id: "max", tkey: "chat.effortMax", icon: "star" },
];

const BY_ID = new Map(CHAT_EFFORT_META.map(meta => [meta.id, meta]));

export function isChatEffort(value: unknown): value is ChatEffort {
  return typeof value === "string" && BY_ID.has(value as ChatEffort);
}

/**
 * Normalize a persisted or remembered value. A thread saved before this control
 * existed (or by a future build with more rungs) must not send an effort the
 * proxy would reject — it degrades to the default instead.
 */
export function sanitizeChatEffort(value: unknown): ChatEffort {
  return isChatEffort(value) ? value : DEFAULT_CHAT_EFFORT;
}

export function chatEffortMeta(effort: ChatEffort): ChatEffortMeta {
  return BY_ID.get(effort) ?? CHAT_EFFORT_META[1]!;
}

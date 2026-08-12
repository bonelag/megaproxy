/**
 * Model picker source for the Chat tab.
 *
 * Reuses `/api/models` — the same row list the Models tab renders — so "the
 * models I can chat with" is exactly "the models this proxy exposes", including
 * native rows, routed provider rows, combos, and custom models. Disabled rows
 * are dropped: they are hidden from the catalog and `/v1/models`, so routing
 * would reject them.
 *
 * Media-generation models are dropped too. They route, but they answer with an
 * image/video job rather than chat text, so offering them in a text chat is an
 * invitation to a confusing failure.
 */
import type { TFn } from "../i18n/shared";
import { formatNamespacedModelId, formatProviderDisplayName } from "../provider-icons";

export interface ChatModelOption {
  /** The value sent as `model` on the wire (namespaced routing slug). */
  id: string;
  label: string;
  /**
   * The routing slug as shown to the user (`agr/claude-opus-5`). Equal to `id`
   * except where a provider id needs disambiguating for display — never paste
   * this into a config; `id` is the wire value.
   */
  slug: string;
  /** Raw provider id, for grouping and search. */
  providerId: string;
  /** Provider display name, for the group header. */
  provider: string;
  native: boolean;
  supportsImages: boolean;
  contextWindow?: number;
}

/** One provider's models, as the picker panel renders them. */
export interface ChatModelGroup {
  providerId: string;
  provider: string;
  native: boolean;
  models: ChatModelOption[];
}

interface ModelsApiRow {
  provider?: unknown;
  id?: unknown;
  namespaced?: unknown;
  disabled?: unknown;
  native?: unknown;
  displayName?: unknown;
  inputModalities?: unknown;
  contextWindow?: unknown;
}

const MEDIA_GEN_MARKERS = [
  "dall-e", "dalle", "imagen", "sora", "veo", "flux", "kling", "seedance",
  "hailuo", "stable-diffusion", "sdxl", "midjourney", "whisper", "tts",
  "embedding", "moderation", "rerank",
];

function looksLikeNonChatModel(id: string): boolean {
  const slug = id.toLowerCase();
  return MEDIA_GEN_MARKERS.some(marker => slug.includes(marker));
}

export function toChatModelOptions(rows: unknown, t: TFn): ChatModelOption[] {
  if (!Array.isArray(rows)) return [];
  const options: ChatModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as ModelsApiRow;
    if (row.disabled === true) continue;
    const namespaced = typeof row.namespaced === "string" ? row.namespaced : "";
    const id = typeof row.id === "string" ? row.id : "";
    const wireId = namespaced || id;
    if (!wireId || seen.has(wireId)) continue;
    if (looksLikeNonChatModel(wireId)) continue;
    seen.add(wireId);
    const provider = typeof row.provider === "string" ? row.provider : "";
    const modalities = Array.isArray(row.inputModalities)
      ? row.inputModalities.filter((m): m is string => typeof m === "string")
      : [];
    const native = row.native === true;
    const providerId = native ? "openai" : provider;
    options.push({
      id: wireId,
      // Display name when the operator set one, else the slug the wire uses —
      // never a prettified form that cannot be pasted back into a config.
      label: typeof row.displayName === "string" && row.displayName ? row.displayName : wireId,
      slug: formatNamespacedModelId(wireId, t),
      providerId,
      provider: formatProviderDisplayName(providerId, t),
      native,
      // Native GPT rows accept images; routed rows must advertise it. An unknown
      // modality list is treated as text-only so the composer's hint stays honest.
      supportsImages: native || modalities.includes("image"),
      ...(typeof row.contextWindow === "number" ? { contextWindow: row.contextWindow } : {}),
    });
  }
  return options.sort((a, b) => {
    if (a.native !== b.native) return a.native ? -1 : 1;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

/**
 * Group the flat option list by provider, preserving the option order (native
 * first, then providers alphabetically) so the panel's groups appear in the same
 * order the flat list resolves its default from.
 */
export function groupChatModels(options: ChatModelOption[]): ChatModelGroup[] {
  const groups: ChatModelGroup[] = [];
  const byProvider = new Map<string, ChatModelGroup>();
  for (const option of options) {
    let group = byProvider.get(option.providerId);
    if (!group) {
      group = { providerId: option.providerId, provider: option.provider, native: option.native, models: [] };
      byProvider.set(option.providerId, group);
      groups.push(group);
    }
    group.models.push(option);
  }
  return groups;
}

/**
 * Filter for the picker's search box. Matches the label, the wire slug, and the
 * provider name, so "antigravity", "opus", and "agr/claude" all find something.
 * Empty query returns the input untouched rather than a copy.
 */
export function filterChatModels(options: ChatModelOption[], query: string): ChatModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(option =>
    option.label.toLowerCase().includes(needle)
    || option.slug.toLowerCase().includes(needle)
    || option.id.toLowerCase().includes(needle)
    || option.provider.toLowerCase().includes(needle)
    || option.providerId.toLowerCase().includes(needle));
}

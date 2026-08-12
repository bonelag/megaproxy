/**
 * Claude adaptive-thinking wire detection.
 *
 * Shared by the native Anthropic adapter and the openai-chat path: many
 * OpenAI-compatible gateways re-emit Claude traffic as Anthropic Messages, so a
 * request that arrives with `reasoning_effort` can leave the gateway as
 * `thinking: {type: "enabled"}` — which adaptive families reject with a 400
 * telling the caller to use `thinking.type.adaptive` + `output_config.effort`.
 *
 * Detection is family/version based rather than a static id list so date-pinned
 * and vendor-suffixed ids keep matching without a registry rewrite.
 */

/**
 * Claude families that moved to adaptive thinking: they 400 on `thinking.type: "enabled"`
 * ("Use \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."),
 * while older families (Haiku 4.5, Sonnet 4.x, Opus <= 4.6) 400 on `adaptive` — so both wire
 * shapes must stay. Verified against api.anthropic.com: sonnet-5, fable-5, opus-4-7 and opus-4-8
 * require adaptive; haiku-4-5 and sonnet-4-5 reject it; opus-4-6/sonnet-4-6 accept both.
 */
const ADAPTIVE_THINKING_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
};

/**
 * Family/version parse for a Claude model id, tolerant of a routing prefix.
 *
 * `parsed.modelId` is not always bare, and the slash can fall on either side.
 * A `modelMap` entry may point at a routed destination such as
 * `anthropic/claude-sonnet-5` (prefix), while a custom provider may expose a
 * native id such as `claude-sonnet-5/variant` (suffix); both survive routing's
 * known-id decoding. So this matches the segment that actually begins with
 * `claude-` rather than assuming it is the first or the last one.
 *
 * Minor is 1-2 digits with a non-digit lookahead so date-pinned ids
 * ("claude-opus-4-20250514") parse as minor 0 instead of minor 20250514;
 * suffixed ids ("claude-opus-4-8[1m]") still match.
 */
export function claudeFamilyVersion(modelId: string): { family: string; major: number; minor: number } | undefined {
  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(modelId);
  if (!match) return undefined;
  return {
    family: match[1]!,
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function meetsFamilyMinimum(
  modelId: string,
  minimums: Record<string, readonly [major: number, minor: number]>,
): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (!parsed) return false;
  const minimum = minimums[parsed.family];
  if (!minimum) return false;
  return parsed.major > minimum[0] || (parsed.major === minimum[0] && parsed.minor >= minimum[1]);
}

/** True when this Claude model requires the adaptive thinking wire. */
export function usesAdaptiveThinking(modelId: string): boolean {
  return meetsFamilyMinimum(modelId, ADAPTIVE_THINKING_FAMILY_MINIMUMS);
}

/**
 * Claude families that (a) think by DEFAULT when the request omits `thinking`,
 * and (b) accept an explicit `thinking: {type: "disabled"}` to turn it off.
 *
 * Deliberately NOT `usesAdaptiveThinking()`, which answers a different question
 * (which wire shape a family accepts). The two sets differ in both directions:
 * Fable always thinks and REJECTS an explicit disable, while Opus 4.7/4.8 use
 * the adaptive wire but leave thinking off when the field is omitted, so they
 * need no disable at all.
 */
const EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
};

export function supportsExplicitThinkingDisable(modelId: string): boolean {
  return meetsFamilyMinimum(modelId, EXPLICIT_THINKING_DISABLE_FAMILY_MINIMUMS);
}

/** `output_config.effort` accepts low|medium|high|xhigh|max — "minimal" is rejected with a 400. */
export function adaptiveEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

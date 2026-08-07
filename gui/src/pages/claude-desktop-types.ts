/**
 * Claude Desktop page data shapes and pure helpers.
 *
 * Split out of ClaudeDesktop.tsx so the page file owns layout and server calls only,
 * and each settings category (profile JSON, Chat tab, per-family models) can grow
 * without pushing the page past a readable size.
 */
import type { TFn, TKey } from "../i18n/shared";

export const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
export type Family = typeof FAMILIES[number];

/** Family display names, kept beside FAMILIES so a new tier cannot ship without a label. */
export const FAMILY_KEYS: Record<Family, TKey> = {
  opus: "claudeDesktop.family.opus",
  fable: "claudeDesktop.family.fable",
  sonnet: "claudeDesktop.family.sonnet",
  haiku: "claudeDesktop.family.haiku",
};

export interface Assignment {
  family: Family;
  alias: string;
  /**
   * Explicit Desktop 1M pins. Absent means "derive from the context window", which is
   * what `autoSupports1m` on the model reports. Kept optional so a profile the user
   * never touched round-trips byte-identical and never reads as unsaved.
   */
  supports1m?: boolean;
  prefer1m?: boolean;
}

export interface DesktopProfile {
  version: 1;
  assignments: Record<string, Assignment>;
  defaults: Record<Family, string | null>;
  /** Chat tab pin written into the applied 3P config. Server defaults it to true. */
  chatTabEnabled?: boolean;
  /** Written by the apply route; mirrors OcxClaudeDesktopProfile so a round-trip keeps them. */
  appliedFingerprint?: string;
  appliedAt?: string;
}

export interface DesktopModel {
  route: string;
  label: string;
  available: boolean;
  contextWindow?: number;
  effortSupported?: boolean;
  /** Effective pin the writer will emit (assignment override, else catalog-derived). */
  supports1m?: boolean;
  prefer1m?: boolean;
  /** Catalog-derived eligibility, ignoring any assignment override. */
  autoSupports1m?: boolean;
  assignment: Assignment;
}

export interface DesktopStatus {
  applied: boolean;
  appliedAt: string | null;
  stale: boolean;
  /**
   * Whether Desktop's _meta.json appliedId actually points at our profile.
   * Desktop serves only that one, so false means it is ignoring us even when
   * `applied` (our saved fingerprint) says otherwise. null = undeterminable.
   */
  activeProfile?: boolean | null;
  health: { lastRequestAt: string | null; requestCount: number; errorCount: number };
}

export interface DesktopResponse {
  profile: DesktopProfile;
  models: DesktopModel[];
  rendered: unknown[];
  port: number;
}

export type PendingAction = "save" | "apply" | null;

/** Copy one assignment without inventing the optional 1M keys. */
export function cloneAssignment(assignment: Assignment): Assignment {
  return {
    family: assignment.family,
    alias: assignment.alias,
    ...(assignment.supports1m !== undefined ? { supports1m: assignment.supports1m } : {}),
    ...(assignment.prefer1m !== undefined ? { prefer1m: assignment.prefer1m } : {}),
  };
}

export function cloneProfile(profile: DesktopProfile): DesktopProfile {
  return {
    version: 1,
    assignments: Object.fromEntries(
      Object.entries(profile.assignments).map(([route, assignment]) => [route, cloneAssignment(assignment)]),
    ),
    defaults: { ...profile.defaults },
    // The saved-profile clone is compared against `profile` to compute `dirty`. Dropping the
    // applied-state markers here would make a freshly loaded profile read as unsaved the moment
    // the server had ever applied it.
    ...(profile.chatTabEnabled !== undefined ? { chatTabEnabled: profile.chatTabEnabled } : {}),
    ...(profile.appliedFingerprint !== undefined ? { appliedFingerprint: profile.appliedFingerprint } : {}),
    ...(profile.appliedAt !== undefined ? { appliedAt: profile.appliedAt } : {}),
  };
}

/**
 * Fill in any route the server knows about, preserving every field it sent.
 *
 * The 1M pins must survive verbatim: the PUT route rejects a changed assignment for an
 * unavailable model, so silently dropping `supports1m` here would make saving fail for
 * any profile that had ever pinned one.
 */
export function normalizeProfile(data: DesktopResponse): DesktopProfile {
  const assignments = { ...data.profile.assignments };
  for (const model of data.models) {
    const current = assignments[model.route] ?? model.assignment;
    assignments[model.route] = {
      family: FAMILIES.includes(current?.family) ? current.family : "opus",
      alias: typeof current?.alias === "string" ? current.alias : "",
      ...(typeof current?.supports1m === "boolean" ? { supports1m: current.supports1m } : {}),
      ...(typeof current?.prefer1m === "boolean" ? { prefer1m: current.prefer1m } : {}),
    };
  }
  return {
    version: 1,
    assignments,
    defaults: {
      opus: data.profile.defaults.opus ?? null,
      fable: data.profile.defaults.fable ?? null,
      sonnet: data.profile.defaults.sonnet ?? null,
      haiku: data.profile.defaults.haiku ?? null,
    },
    // Absent means the server could not state a preference; the writer's own default is on.
    chatTabEnabled: data.profile.chatTabEnabled !== false,
  };
}

/**
 * Effective 1M pins for one row — the same rule the server applies, so the toggles
 * never disagree with what apply writes.
 *
 * `prefer1m` is gated behind `supports1m` in both directions: turning support off must
 * visibly turn preference off too, rather than leaving a live-looking control that the
 * writer silently ignores.
 */
export function effective1m(
  assignment: Assignment | undefined,
  autoSupports1m: boolean,
): { supports1m: boolean; prefer1m: boolean } {
  const supports1m = assignment?.supports1m ?? autoSupports1m;
  const prefer1m = supports1m && (assignment?.prefer1m ?? supports1m);
  return { supports1m, prefer1m };
}

export function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return fallback;
}

export function formatContextWindow(value: number | undefined, t: TFn): string | null {
  if (!value) return null;
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

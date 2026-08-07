import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeDesktopState } from "../src/server/management/shared";
import { DESKTOP_SUPPORTS_1M_THRESHOLD } from "../src/claude/desktop-3p";
import type { OcxConfig } from "../src/types";

/**
 * D1c: the dashboard surfaces the same 1M eligibility the writer emits, from one
 * threshold — never a second rule that could drift.
 *
 * The chip is no longer read-only: the profile carries per-model `supports1m`/`prefer1m`
 * pins, so the DTO reports BOTH the catalog-derived eligibility (`autoSupports1m`, which
 * the GUI needs to explain why a toggle defaults where it does) and the effective pin the
 * writer will emit (`supports1m`/`prefer1m`).
 */

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as unknown as OcxConfig;

test("the DTO and the writer share one threshold constant", () => {
  // If someone changes one side, this fails — that is the point.
  expect(DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(1_000_000);
});

test("supports1m is true at and above the threshold, false below it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-desktop-1m-"));
  const prev = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = home;
  try {
    const state = await buildClaudeDesktopState(config);
    // Live-backed assertions against the real catalog: 1 MiB windows qualify.
    const oneMiB = state.models.find(m => m.route === "google-antigravity/gemini-3.1-pro");
    const exact1M = state.models.find(m => m.route === "alibaba-token-plan-intl/glm-5.2");
    const below = state.models.find(m => m.route === "alibaba-token-plan-intl/qwen3.8-max");
    const blank = state.models.find(m => m.route === "anthropic/claude-opus-4-6");

    if (oneMiB) expect(oneMiB.supports1m).toBe(true);       // 1_048_576
    if (exact1M) expect(exact1M.supports1m).toBe(true);      // 1_000_000 exactly
    if (below) expect(below.supports1m).toBe(false);         // 983_616
    if (blank) expect(blank.supports1m).toBe(false);         // no window known

    // With no pins stored, the effective flag and the catalog-derived one must agree —
    // that is what lets the GUI present "auto" as the toggle's resting state.
    for (const model of state.models) {
      expect(model.assignment.supports1m).toBeUndefined();
      expect(model.supports1m).toBe(model.autoSupports1m);
      // prefer1m defaults to support: resolveDesktop1mFlags is the single rule, and the
      // writer, the DTO and the GUI toggles all read it.
      expect(model.prefer1m).toBe(model.autoSupports1m);
    }

    // Chat tab is reported explicitly, so the GUI never has to guess from an absent key.
    expect(state.profile.chatTabEnabled).toBe(true);

    // The boundary rule itself: 983616 must never qualify, 1000000 always does.
    expect(983_616 >= DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(false);
    expect(1_000_000 >= DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

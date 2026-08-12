/**
 * Chat model picker source and attachment classification.
 *
 * These two helpers decide what the composer offers and what it refuses, so
 * their edges (disabled rows, non-chat models, unknown MIME types, caps) are
 * asserted directly.
 */
import { expect, test } from "bun:test";
import { filterChatModels, groupChatModels, toChatModelOptions } from "../src/chat/models";
import { classifyFile, readAttachments, MAX_ATTACHMENTS, MAX_TEXT_BYTES } from "../src/chat/attachments";
import { CHAT_EFFORT_META, DEFAULT_CHAT_EFFORT, isChatEffort, sanitizeChatEffort } from "../src/chat/effort";
import { relativeAge } from "../src/chat/relative-age";
import { en } from "../src/i18n/en";
import type { TKey, Vars } from "../src/i18n/shared";

const t = ((key: TKey, vars?: Vars) => {
  let out: string = en[key];
  for (const [name, value] of Object.entries(vars ?? {})) out = out.split(`{${name}}`).join(String(value));
  return out;
}) as (key: TKey, vars?: Vars) => string;

test("disabled rows and media-generation models are excluded", () => {
  const options = toChatModelOptions([
    { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", disabled: false, native: true },
    { provider: "openai", id: "gpt-old", namespaced: "gpt-old", disabled: true, native: true },
    { provider: "a", id: "dall-e-3", namespaced: "a/dall-e-3", disabled: false },
    { provider: "a", id: "text-embedding-3", namespaced: "a/text-embedding-3", disabled: false },
    { provider: "a", id: "chat-model", namespaced: "a/chat-model", disabled: false },
  ], t);
  expect(options.map(option => option.id)).toEqual(["gpt-5.6-sol", "a/chat-model"]);
});

test("native rows lead, then providers alphabetically", () => {
  const options = toChatModelOptions([
    { provider: "zeta", id: "m", namespaced: "zeta/m", disabled: false },
    { provider: "alpha", id: "m", namespaced: "alpha/m", disabled: false },
    { provider: "openai", id: "gpt-5.5", namespaced: "gpt-5.5", disabled: false, native: true },
  ], t);
  expect(options.map(option => option.id)).toEqual(["gpt-5.5", "alpha/m", "zeta/m"]);
});

test("image support comes from inputModalities, and native rows always qualify", () => {
  const options = toChatModelOptions([
    { provider: "openai", id: "gpt-5.5", namespaced: "gpt-5.5", disabled: false, native: true },
    { provider: "a", id: "vision", namespaced: "a/vision", disabled: false, inputModalities: ["text", "image"] },
    { provider: "a", id: "text", namespaced: "a/text", disabled: false, inputModalities: ["text"] },
    { provider: "a", id: "unknown", namespaced: "a/unknown", disabled: false },
  ], t);
  const byId = new Map(options.map(option => [option.id, option.supportsImages]));
  expect(byId.get("gpt-5.5")).toBe(true);
  expect(byId.get("a/vision")).toBe(true);
  expect(byId.get("a/text")).toBe(false);
  // No advertised modality list means the hint stays conservative.
  expect(byId.get("a/unknown")).toBe(false);
});

test("a display name labels the row but the wire id stays the routing slug", () => {
  const options = toChatModelOptions([
    { provider: "a", id: "m", namespaced: "a/m", disabled: false, displayName: "Pretty Name" },
  ], t);
  expect(options[0]!.id).toBe("a/m");
  expect(options[0]!.label).toBe("Pretty Name");
  // The panel's second line shows the namespaced slug, not the pretty name.
  expect(options[0]!.slug).toBe("a/m");
});

test("groupChatModels buckets by provider and keeps native first", () => {
  const options = toChatModelOptions([
    { provider: "zeta", id: "b", namespaced: "zeta/b", disabled: false },
    { provider: "zeta", id: "a", namespaced: "zeta/a", disabled: false },
    { provider: "openai", id: "gpt-5.5", namespaced: "gpt-5.5", disabled: false, native: true },
  ], t);
  const groups = groupChatModels(options);
  expect(groups.map(group => group.providerId)).toEqual(["openai", "zeta"]);
  expect(groups[0]!.native).toBe(true);
  // The per-group count badge in the panel is exactly this length.
  expect(groups[1]!.models).toHaveLength(2);
  expect(groups[1]!.models.map(model => model.id)).toEqual(["zeta/a", "zeta/b"]);
});

test("filterChatModels matches the label, the slug, and the provider", () => {
  const options = toChatModelOptions([
    { provider: "antigravity", id: "claude-opus-4-6-thinking", namespaced: "antigravity/claude-opus-4-6-thinking", disabled: false, displayName: "Claude Opus 4.6 (Thinking)" },
    { provider: "zeta", id: "llama", namespaced: "zeta/llama", disabled: false },
  ], t);
  expect(filterChatModels(options, "opus").map(option => option.id)).toEqual(["antigravity/claude-opus-4-6-thinking"]);
  expect(filterChatModels(options, "antigravity/claude").map(option => option.id)).toEqual(["antigravity/claude-opus-4-6-thinking"]);
  expect(filterChatModels(options, "Zeta").map(option => option.id)).toEqual(["zeta/llama"]);
  expect(filterChatModels(options, "nothing-here")).toEqual([]);
  // An empty query is the identity, not a filtered copy.
  expect(filterChatModels(options, "  ")).toBe(options);
});

test("the effort ladder covers exactly the wire values the proxy accepts", () => {
  // These ids are the wire contract with src/chat/inbound.ts — renaming one
  // silently drops the effort from the request.
  expect(CHAT_EFFORT_META.map(meta => meta.id)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  for (const meta of CHAT_EFFORT_META) expect(en[meta.tkey].length).toBeGreaterThan(0);
  expect(isChatEffort("xhigh")).toBe(true);
  expect(isChatEffort("ultra")).toBe(false);
  // A thread saved before this control existed must not send an unknown rung.
  expect(sanitizeChatEffort(undefined)).toBe(DEFAULT_CHAT_EFFORT);
  expect(sanitizeChatEffort("nonsense")).toBe(DEFAULT_CHAT_EFFORT);
  expect(sanitizeChatEffort("max")).toBe("max");
});

test("relativeAge stays compact across the ladder", () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);
  // Exact wording is CLDR's (narrow style: "1m ago" in this ICU build), so the
  // assertions are on our contract instead: the right count, the right unit
  // letter where CLDR uses one, and no trailing "ago" — the column is ~40px.
  const cases: Array<[string, number, string]> = [
    ["1", 30_000, "under a minute floors to one minute"],
    ["1", 60_000, "one minute"],
    ["5", 5 * 60_000, "minutes"],
    ["3", 3 * 3_600_000, "hours"],
    ["7", 7 * 86_400_000, "days"],
  ];
  for (const [expectedCount, age, what] of cases) {
    const text = relativeAge(now - age, "en-US", now);
    expect(text, what).toContain(expectedCount);
    expect(text, what).not.toContain("ago");
    expect(text.length, what).toBeLessThanOrEqual(8);
  }
  // Past a month it becomes an absolute date rather than an unreadable day count.
  expect(relativeAge(Date.UTC(2025, 9, 4), "en-US", now)).toBe("Oct 4");
});

test("a non-array payload yields no options rather than throwing", () => {
  expect(toChatModelOptions(null, t)).toEqual([]);
  expect(toChatModelOptions({ error: "nope" }, t)).toEqual([]);
});

test("classifyFile recognizes images, text types, and code extensions", () => {
  expect(classifyFile(new File([""], "a.png", { type: "image/png" }))).toBe("image");
  expect(classifyFile(new File([""], "a.txt", { type: "text/plain" }))).toBe("text");
  expect(classifyFile(new File([""], "a.json", { type: "application/json" }))).toBe("text");
  // No MIME type reported (common for code files) — the extension decides.
  expect(classifyFile(new File([""], "a.ts", { type: "" }))).toBe("text");
  expect(classifyFile(new File([""], "Dockerfile", { type: "" }))).toBe("text");
  // An unknown binary must be refused, not sent as base64 the model cannot read.
  expect(classifyFile(new File([""], "a.bin", { type: "application/octet-stream" }))).toBeNull();
});

test("readAttachments reports per-file failures without discarding good files", async () => {
  const result = await readAttachments([
    new File(["const a = 1;"], "a.ts", { type: "text/plain" }),
    new File([""], "a.bin", { type: "application/octet-stream" }),
  ], 0);
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]!.kind).toBe("text");
  expect(result.attachments[0]!.text).toBe("const a = 1;");
  expect(result.errors).toEqual([{ reason: "unsupported", name: "a.bin" }]);
});

test("an oversized text file is refused with its limit", async () => {
  const big = new File(["x".repeat(MAX_TEXT_BYTES + 1)], "big.txt", { type: "text/plain" });
  const result = await readAttachments([big], 0);
  expect(result.attachments).toHaveLength(0);
  expect(result.errors).toEqual([{ reason: "too-large", name: "big.txt", limit: MAX_TEXT_BYTES }]);
});

test("the attachment cap counts what is already attached", async () => {
  const files = Array.from({ length: 3 }, (_, index) =>
    new File(["x"], `f${index}.txt`, { type: "text/plain" }));
  const result = await readAttachments(files, MAX_ATTACHMENTS - 1);
  expect(result.attachments).toHaveLength(1);
  expect(result.errors).toEqual([{ reason: "too-many", limit: MAX_ATTACHMENTS }]);
});

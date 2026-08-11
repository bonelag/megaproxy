import { expect, test } from "bun:test";
import { composeProviderHeaders, newHeaderRow, splitProviderHeaders } from "../src/provider-headers";
import { buildProviderPayload } from "../src/provider-payload";

test("splitProviderHeaders peels User-Agent and keeps other rows", () => {
  const split = splitProviderHeaders({
    "User-Agent": "ua/1",
    "X-Test": "1",
  });
  expect(split.userAgent).toBe("ua/1");
  expect(split.rows).toHaveLength(1);
  expect(split.rows[0]?.name).toBe("X-Test");
  expect(split.rows[0]?.value).toBe("1");
  expect(splitProviderHeaders(undefined)).toEqual({ userAgent: "", rows: [] });
});

test("composeProviderHeaders maps UA and rows; empty form clears", () => {
  expect(composeProviderHeaders("", [])).toEqual({ ok: true, headers: null });

  const withUa = composeProviderHeaders("  claude-cli/2.1.220  ", []);
  expect(withUa).toEqual({
    ok: true,
    headers: { "User-Agent": "claude-cli/2.1.220" },
  });

  const withRows = composeProviderHeaders("", [
    newHeaderRow("X-App", "gui"),
    newHeaderRow("  ", "  "), // blank row skipped
  ]);
  expect(withRows.ok).toBe(true);
  if (withRows.ok) {
    expect(withRows.headers).toEqual({ "X-App": "gui" });
  }
});

test("composeProviderHeaders rejects empty name, duplicates, UA row, CRLF", () => {
  expect(composeProviderHeaders("", [newHeaderRow("", "v")]).ok).toBe(false);
  expect(composeProviderHeaders("", [
    newHeaderRow("X-A", "1"),
    newHeaderRow("x-a", "2"),
  ])).toEqual({ ok: false, error: "duplicate" });
  expect(composeProviderHeaders("ua", [newHeaderRow("User-Agent", "other")])).toEqual({
    ok: false,
    error: "user-agent-row",
  });
  expect(composeProviderHeaders("bad\rua", [])).toEqual({ ok: false, error: "crlf" });
  expect(composeProviderHeaders("", [newHeaderRow("X-A", "a\nb")])).toEqual({ ok: false, error: "crlf" });
});

test("buildProviderPayload includes composed headers on create", () => {
  const payload = buildProviderPayload({
    name: "custom",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    apiKey: "sk-test",
    defaultModel: "",
    userAgent: "claude-cli/2.1.220 (external, cli)",
    headerRows: [newHeaderRow("X-Test", "1")],
  });
  expect(payload.headers).toEqual({
    "User-Agent": "claude-cli/2.1.220 (external, cli)",
    "X-Test": "1",
  });
  expect(payload.apiKey).toBe("sk-test");
});

test("buildProviderPayload omits headers when form leaves them empty", () => {
  const payload = buildProviderPayload({
    name: "custom",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    apiKey: "",
    defaultModel: "m",
  });
  expect(payload.headers).toBeUndefined();
});

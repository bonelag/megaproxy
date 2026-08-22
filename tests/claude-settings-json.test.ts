import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { readClaudeSettingsJson, updateClaudeSettingsJson } from "../src/claude/settings-file";

let testDir = "";
let previousHome: string | undefined;
let previousClaudeConfigDir: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-settings-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude");

  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
    apiKeys: [
      { id: "k1", name: "dev-key", key: "sk-test-12345", createdAt: new Date().toISOString() },
    ],
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

test("readClaudeSettingsJson and updateClaudeSettingsJson handle env updates", () => {
  const initial = readClaudeSettingsJson();
  expect(initial.exists).toBe(false);
  expect(initial.env).toEqual({});

  const updated = updateClaudeSettingsJson({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
    ANTHROPIC_AUTH_TOKEN: "sk-f547bbc2e0b2d3fc-zwcd8u-775a8534",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "jd/claude-opus-5[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "go/claude-opus-5[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "ftb/deepseek-v4-flash-0731",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "nov/claude-fable-5[1m]",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "test[1m]",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  }, { model: "test[1m]" });

  expect(updated.ok).toBe(true);
  expect(updated.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
  expect(updated.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("jd/claude-opus-5[1m]");
  expect(updated.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("go/claude-opus-5[1m]");
  expect(updated.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("ftb/deepseek-v4-flash-0731");
  expect(updated.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("nov/claude-fable-5[1m]");
  expect(updated.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe("test[1m]");
  expect(updated.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  expect(updated.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
  expect(updated.model).toBe("test[1m]");

  const readBack = readClaudeSettingsJson();
  expect(readBack.exists).toBe(true);
  expect(readBack.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("jd/claude-opus-5[1m]");
  expect(readBack.model).toBe("test[1m]");

  // Test toggling discovery OFF
  const updatedOff = updateClaudeSettingsJson({
    ...readBack.env,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: null,
  });
  expect(updatedOff.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
});

test("GET and PUT /api/claude-code/settings-json endpoints", async () => {
  const server = startServer(0);
  try {
    const get1 = await fetch(new URL("/api/claude-code/settings-json", server.url));
    expect(get1.status).toBe(200);
    const d1 = await get1.json() as Record<string, any>;
    expect(d1.apiKeys).toBeDefined();
    expect(d1.apiKeys.length).toBe(1);
    expect(d1.apiKeys[0].key).toBe("sk-test-12345");
    expect(d1.defaultEndpoint).toContain("http://127.0.0.1:");

    const putRes = await fetch(new URL("/api/claude-code/settings-json", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "jd/claude-opus-5[1m]",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "go/claude-opus-5[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "ftb/deepseek-v4-flash-0731",
          ANTHROPIC_DEFAULT_FABLE_MODEL: "nov/claude-fable-5[1m]",
          ANTHROPIC_CUSTOM_MODEL_OPTION: "test[1m]",
        },
      }),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json() as Record<string, any>;
    expect(putData.ok).toBe(true);
    expect(putData.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("jd/claude-opus-5[1m]");

    const get2 = await fetch(new URL("/api/claude-code/settings-json", server.url));
    expect(get2.status).toBe(200);
    const d2 = await get2.json() as Record<string, any>;
    expect(d2.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(d2.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-token");
    expect(d2.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("jd/claude-opus-5[1m]");
    expect(d2.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("go/claude-opus-5[1m]");
    expect(d2.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("ftb/deepseek-v4-flash-0731");
    expect(d2.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("nov/claude-fable-5[1m]");
    expect(d2.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe("test[1m]");
  } finally {
    server.stop();
  }
});

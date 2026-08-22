import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export function resolveClaudeSettingsPath(): string {
  const customDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (customDir) return join(customDir, "settings.json");
  return join(homedir(), ".claude", "settings.json");
}

export interface ClaudeSettingsFileState {
  path: string;
  exists: boolean;
  env: Record<string, string>;
  model?: string;
  raw?: Record<string, unknown>;
}

export function readClaudeSettingsJson(): ClaudeSettingsFileState {
  const filePath = resolveClaudeSettingsPath();
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, env: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const env = (raw && typeof raw === "object" && raw.env && typeof raw.env === "object" && !Array.isArray(raw.env))
      ? (raw.env as Record<string, string>)
      : {};
    return {
      path: filePath,
      exists: true,
      env: { ...env },
      model: typeof raw.model === "string" ? raw.model : undefined,
      raw,
    };
  } catch {
    return { path: filePath, exists: true, env: {} };
  }
}

export function updateClaudeSettingsJson(
  envUpdates: Record<string, string | null | undefined>,
  extra?: { model?: string },
): { ok: boolean; path: string; env: Record<string, string>; model?: string } {
  const filePath = resolveClaudeSettingsPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }

  const existingEnv: Record<string, unknown> =
    raw && typeof raw.env === "object" && raw.env !== null && !Array.isArray(raw.env)
      ? { ...raw.env }
      : {};

  // Apply env updates
  for (const [key, val] of Object.entries(envUpdates)) {
    if (val === null || val === undefined || (typeof val === "string" && val.trim() === "")) {
      delete existingEnv[key];
    } else {
      existingEnv[key] = String(val).trim();
    }
  }

  if (existingEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    existingEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  if (
    envUpdates.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === null ||
    envUpdates.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === undefined ||
    envUpdates.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "" ||
    envUpdates.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "0"
  ) {
    delete existingEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  } else if (envUpdates.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1") {
    existingEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  }

  // Canonical order: base URL, disable nonessential traffic, auth token, fable, opus, sonnet, haiku, custom, discovery
  const KEY_ORDER = [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  ];

  const orderedEnv: Record<string, string> = {};
  for (const key of KEY_ORDER) {
    if (existingEnv[key] !== undefined) {
      orderedEnv[key] = String(existingEnv[key]);
    }
  }
  for (const [key, val] of Object.entries(existingEnv)) {
    if (!KEY_ORDER.includes(key)) {
      orderedEnv[key] = String(val);
    }
  }

  raw.env = orderedEnv;

  if (extra && extra.model !== undefined) {
    if (extra.model === "" || extra.model === null) {
      delete raw.model;
    } else {
      raw.model = extra.model.trim();
    }
  }

  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf8");

  // Refresh ~/.claude/cache/gateway-models.json
  try {
    const { refreshGatewayModelCacheFromProxy } = require("./gateway-cache");
    let port = 10100;
    if (orderedEnv.ANTHROPIC_BASE_URL) {
      const match = /:(\d+)/.exec(orderedEnv.ANTHROPIC_BASE_URL);
      if (match && match[1]) port = parseInt(match[1], 10);
    }
    void refreshGatewayModelCacheFromProxy(port);
  } catch {
    // best-effort
  }

  return {
    ok: true,
    path: filePath,
    env: orderedEnv,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

import crypto from "node:crypto";

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const OPENCODE_DEFAULT_UA = "opencode/1.18.31";

let cachedSessionId: string | null = null;
let lastSessionTimestamp = 0;
let counter = 0;

function unstableRandom(): string {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i]! % 62];
  }
  return randomPart;
}

export function generateOpenCodeSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

export function generateOpenCodeRequestId(timestamp = Date.now()): string {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

export function getStableOpenCodeSessionId(): string {
  if (!cachedSessionId) {
    cachedSessionId = generateOpenCodeSessionId();
  }
  return cachedSessionId;
}

export function resetOpenCodeSessionIdCache(): void {
  cachedSessionId = null;
}

export function isOpenCodeZenEndpoint(baseUrlOrUrl: string): boolean {
  try {
    const parsed = new URL(baseUrlOrUrl);
    return (
      parsed.hostname === "opencode.ai"
      && (parsed.pathname.startsWith("/zen/") || parsed.pathname === "/zen")
    );
  } catch {
    return false;
  }
}

export function applyOpenCodeZenHeaders(
  headers: Record<string, string>,
  baseUrlOrUrl: string,
  apiKey?: string,
): void {
  if (!isOpenCodeZenEndpoint(baseUrlOrUrl)) return;

  const uaKey = Object.keys(headers).find(k => k.toLowerCase() === "user-agent");
  const currentUa = uaKey ? headers[uaKey] : undefined;
  if (!currentUa || currentUa === "opencode" || !currentUa.toLowerCase().includes("opencode/")) {
    headers["User-Agent"] = OPENCODE_DEFAULT_UA;
    if (uaKey && uaKey !== "User-Agent") delete headers[uaKey];
  }

  const clientKey = Object.keys(headers).find(k => k.toLowerCase() === "x-opencode-client");
  if (!clientKey) {
    headers["x-opencode-client"] = "desktop";
  }

  const sessionKey = Object.keys(headers).find(k => k.toLowerCase() === "x-opencode-session");
  if (!sessionKey) {
    headers["x-opencode-session"] = getStableOpenCodeSessionId();
  }

  const reqKey = Object.keys(headers).find(k => k.toLowerCase() === "x-opencode-request");
  if (!reqKey) {
    headers["x-opencode-request"] = generateOpenCodeRequestId();
  }

  const projKey = Object.keys(headers).find(k => k.toLowerCase() === "x-opencode-project");
  if (!projKey) {
    headers["x-opencode-project"] = "global";
  }

  const authKey = Object.keys(headers).find(k => k.toLowerCase() === "authorization");
  if (!authKey && apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
}

export const OPENCODE_DECOY_CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "This tool is currently unavailable and must not be used.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "This tool is currently unavailable and must not be used.",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

export const OPENCODE_DECOY_RESPONSES_TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "This tool is currently unavailable and must not be used.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "read",
    description: "This tool is currently unavailable and must not be used.",
    parameters: { type: "object", properties: {} },
  },
] as const;

export function cloakOpenCodeZenChatTools(body: Record<string, unknown>): void {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    body.tools = OPENCODE_DECOY_CHAT_TOOLS.map(t => ({
      ...t,
      function: { ...t.function },
    }));
    if (!body.tool_choice) body.tool_choice = "none";
  } else {
    const names = new Set(
      tools.map(t => {
        if (t && typeof t === "object") {
          const fn = (t as { function?: { name?: string } }).function;
          if (fn && typeof fn.name === "string") return fn.name;
          const n = (t as { name?: string }).name;
          if (typeof n === "string") return n;
        }
        return "";
      }),
    );
    for (const tool of OPENCODE_DECOY_CHAT_TOOLS) {
      if (!names.has(tool.function.name)) {
        tools.push({ ...tool, function: { ...tool.function } });
      }
    }
  }
}

export function cloakOpenCodeZenResponsesTools(body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) body.tools = [];
  const tools = body.tools as unknown[];
  const names = new Set(
    tools.map((t: unknown) => {
      if (t && typeof t === "object") {
        const n = (t as { name?: string }).name;
        if (typeof n === "string") return n;
        const fn = (t as { function?: { name?: string } }).function;
        if (fn && typeof fn.name === "string") return fn.name;
      }
      return "";
    }),
  );
  for (const tool of OPENCODE_DECOY_RESPONSES_TOOLS) {
    if (!names.has(tool.name)) {
      tools.push({ ...tool });
    }
  }
  if (!body.tool_choice) {
    body.tool_choice = "auto";
  }
  body.store = false;
  if (Array.isArray(body.input)) {
    body.input = body.input.filter(
      item => !item || typeof item !== "object" || (item as { type?: string }).type !== "reasoning",
    );
  }
}

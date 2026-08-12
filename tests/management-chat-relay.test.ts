/**
 * POST /api/chat/completions — the GUI Chat tab's relay.
 *
 * The property under test is the one the route exists for: chatting from the
 * dashboard needs NO data-plane API key, even on a config where `/v1/*` demands
 * one (non-loopback hostname + configured `apiKeys`). Management auth already
 * gated the request before dispatch, and this suite drives `handleManagementAPI`
 * directly, which is exactly that post-gate position.
 *
 * The second property is that nothing about the pipeline changes: the same
 * translate-and-replay reaches the same upstream with the same body, and the
 * provider's custom headers still ride along (the "no exceptions" guarantee from
 * the custom-header work must hold for this entry point too).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { resetLifecycleDrainStateForTests, getActiveTurnCount } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { ManagementRequest } from "./helpers/management-auth";

const REAL_LOOKING_KEY = "ocx_live_5b1e0c7a94d24f3b8ae61d05c73f9284";

interface Upstream {
  stop(): void;
  url: string;
  requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
}

function mockUpstream(): Upstream {
  const requests: Upstream["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of req.headers) headers[name.toLowerCase()] = value;
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* keep going */ }
      requests.push({ headers, body });
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " world" } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * A config whose data plane REQUIRES a key: non-loopback hostname makes
 * `isApiAuthRequired` true, and `apiKeys` gives it a real secret to demand. If
 * the relay were gated like `/v1/chat/completions`, every test below would 401.
 */
function keyRequiredConfig(baseUrl: string, headers?: Record<string, string>): OcxConfig {
  return {
    port: 10199,
    hostname: "0.0.0.0",
    defaultProvider: "mock",
    apiKeys: [{ id: "key-1", name: "default", key: REAL_LOOKING_KEY, createdAt: new Date(0).toISOString() }],
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "upstream-key",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["test-model"],
        ...(headers ? { headers } : {}),
      },
    },
  } as OcxConfig;
}

function relay(config: OcxConfig, body: unknown, init?: RequestInit): Promise<Response | null> {
  const url = new URL("http://127.0.0.1:10199/api/chat/completions");
  return handleManagementAPI(
    new ManagementRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", Host: url.host, ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
}

beforeEach(() => {
  resetLifecycleDrainStateForTests();
});

afterEach(() => {
  resetLifecycleDrainStateForTests();
});

test("relays a streaming turn with no data-plane API key on a key-required config", async () => {
  const upstream = mockUpstream();
  try {
    const config = keyRequiredConfig(upstream.url);
    const response = await relay(config, {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toContain("text/event-stream");
    const text = await response!.text();
    expect(text).toContain("Hello");
    expect(text).toContain("[DONE]");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.body.model).toBe("test-model");
  } finally {
    upstream.stop();
  }
});

test("non-streaming turns fold to a single JSON completion", async () => {
  const upstream = mockUpstream();
  try {
    const response = await relay(keyRequiredConfig(upstream.url), {
      model: "mock/test-model",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toContain("application/json");
    const body = await response!.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(body.choices?.[0]?.message?.content).toBe("Hello world");
  } finally {
    upstream.stop();
  }
});

test("provider custom User-Agent and headers still reach the upstream", async () => {
  const upstream = mockUpstream();
  try {
    const config = keyRequiredConfig(upstream.url, {
      "User-Agent": "claude-cli/2.1.220 (external, cli)",
      "X-Test": "relay",
    });
    const response = await relay(config, {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response!.status).toBe(200);
    await response!.text();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.headers["user-agent"]).toBe("claude-cli/2.1.220 (external, cli)");
    expect(upstream.requests[0]!.headers["x-test"]).toBe("relay");
  } finally {
    upstream.stop();
  }
});

test("the management credential is never forwarded upstream as data-plane auth", async () => {
  const upstream = mockUpstream();
  try {
    const response = await relay(
      keyRequiredConfig(upstream.url),
      { model: "mock/test-model", stream: true, messages: [{ role: "user", content: "hi" }] },
      { headers: { authorization: `Bearer ${REAL_LOOKING_KEY}` } },
    );
    expect(response!.status).toBe(200);
    await response!.text();
    const seen = upstream.requests[0]!.headers;
    // The provider's own key is what authenticates upstream; the dashboard token
    // must not appear anywhere in the outbound request.
    expect(seen.authorization).toBe("Bearer upstream-key");
    expect(JSON.stringify(seen)).not.toContain(REAL_LOOKING_KEY);
  } finally {
    upstream.stop();
  }
});

test("an unreachable provider surfaces an error without leaking the turn lease", async () => {
  // Port 1 is not listening; the adapter's fetch fails, which is the ordinary
  // upstream-failure path rather than a routing rejection. `defaultProvider`
  // means an unknown MODEL would instead fall back to `mock`, so a bad model
  // name is not a failure path to test here.
  const response = await relay(keyRequiredConfig("http://127.0.0.1:1/v1"), {
    model: "mock/test-model",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(response).not.toBeNull();
  expect(response!.ok).toBe(false);
  await response!.text();
  // The relay releases its lease on every non-transferred path; a leak here
  // would eventually exhaust the active-turn gate for the whole process.
  expect(getActiveTurnCount()).toBe(0);
});

test("the GUI's thinking effort reaches the provider's outbound wire", async () => {
  const upstream = mockUpstream();
  try {
    // Exactly what gui/src/chat/client.ts sends for the "Extra high" rung. The
    // interesting part is the far end: the relay -> Chat->Responses translation
    // -> routing -> openai-chat adapter chain must put a real effort on the
    // PROVIDER request, not just accept the field and drop it.
    const response = await relay(keyRequiredConfig(upstream.url), {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "xhigh",
      reasoning_summary: "auto",
    });
    expect(response!.status).toBe(200);
    await response!.text();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.body.reasoning_effort).toBe("xhigh");
  } finally {
    upstream.stop();
  }
});

test("\"no thinking\" is honored per the provider's reasoning wire shape", async () => {
  const upstream = mockUpstream();
  try {
    // A provider that documents a reasoning wire shape gets an explicit
    // "don't think" instruction...
    const gateway = keyRequiredConfig(upstream.url);
    gateway.providers.mock!.reasoningWireFormat = "gateway-object";
    const response = await relay(gateway, {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
      reasoning_summary: "auto",
    });
    expect(response!.status).toBe(200);
    await response!.text();
    expect(upstream.requests[0]!.body.reasoning).toEqual({ enabled: false });
  } finally {
    upstream.stop();
  }
});

test("\"no thinking\" strips reasoning for a provider with no documented none value", async () => {
  const upstream = mockUpstream();
  try {
    // ...while a plain OpenAI-compatible endpoint has no portable way to say it,
    // so mapReasoningEffort strips the field rather than sending a value the
    // gateway would 400 on. Either way the turn asks for less thinking, never
    // more — which is the property the rung promises.
    const response = await relay(keyRequiredConfig(upstream.url), {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
      reasoning_summary: "auto",
    });
    expect(response!.status).toBe(200);
    await response!.text();
    expect(upstream.requests[0]!.body.reasoning_effort).toBeUndefined();
    expect(upstream.requests[0]!.body.reasoning).toBeUndefined();
  } finally {
    upstream.stop();
  }
});

test("a turn with no effort leaves the provider request unconstrained", async () => {
  const upstream = mockUpstream();
  try {
    const response = await relay(keyRequiredConfig(upstream.url), {
      model: "mock/test-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response!.status).toBe(200);
    await response!.text();
    expect(upstream.requests[0]!.body.reasoning_effort).toBeUndefined();
  } finally {
    upstream.stop();
  }
});

test("a malformed body answers 400 rather than reaching a provider", async () => {
  const upstream = mockUpstream();
  try {
    const url = new URL("http://127.0.0.1:10199/api/chat/completions");
    const response = await handleManagementAPI(
      new ManagementRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json", Host: url.host },
        body: "{not json",
      }),
      url,
      keyRequiredConfig(upstream.url),
      { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
    );
    expect(response!.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
    expect(getActiveTurnCount()).toBe(0);
  } finally {
    upstream.stop();
  }
});

test("GET on the relay path is not a route", async () => {
  const url = new URL("http://127.0.0.1:10199/api/chat/completions");
  const response = await handleManagementAPI(
    new ManagementRequest(url, { headers: { Host: url.host } }),
    url,
    keyRequiredConfig("http://127.0.0.1:1/v1"),
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  expect(response).toBeNull();
});

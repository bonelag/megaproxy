/**
 * Chat wire construction and SSE parsing.
 *
 * `toWireMessages` is the one place transcript shape becomes request shape, so
 * its rules (system prompt first, text attachments inlined, images as
 * `image_url`, empty assistant turns dropped) are asserted directly rather than
 * through a mounted component.
 */
import { expect, test } from "bun:test";
import { ChatStreamError, composeMessageText, sendChatTurn, toWireMessages } from "../src/chat/client";
import type { ChatMessage } from "../src/chat/types";

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt: 0,
    ...overrides,
  };
}

test("toWireMessages puts the system prompt first and keeps turn order", () => {
  const wire = toWireMessages([
    userMessage({ id: "a", content: "one" }),
    { id: "b", role: "assistant", content: "two", createdAt: 1 },
    userMessage({ id: "c", content: "three" }),
  ], "be brief");
  expect(wire).toEqual([
    { role: "system", content: "be brief" },
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
});

test("an empty assistant turn is dropped from the replay", () => {
  const wire = toWireMessages([
    userMessage(),
    { id: "b", role: "assistant", content: "", createdAt: 1, error: "boom" },
  ]);
  expect(wire).toEqual([{ role: "user", content: "hello" }]);
});

test("image attachments become image_url parts alongside the text part", () => {
  const wire = toWireMessages([userMessage({
    attachments: [{
      id: "att1",
      name: "shot.png",
      mediaType: "image/png",
      size: 10,
      kind: "image",
      dataUrl: "data:image/png;base64,AAA",
    }],
  })]);
  expect(wire).toEqual([{
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ],
  }]);
});

test("text attachments are inlined as a fenced block, not sent as a file part", () => {
  const wire = toWireMessages([userMessage({
    content: "review this",
    attachments: [{
      id: "att1",
      name: "a.ts",
      mediaType: "text/plain",
      size: 12,
      kind: "text",
      text: "const a = 1;",
    }],
  })]);
  expect(wire).toHaveLength(1);
  const content = wire[0]!.content;
  expect(typeof content).toBe("string");
  expect(content as string).toContain("review this");
  expect(content as string).toContain("Attached file: a.ts");
  expect(content as string).toContain("const a = 1;");
});

test("composeMessageText fences with four backticks so nested fences cannot escape", () => {
  const text = composeMessageText("look", [{
    id: "att1",
    name: "readme.md",
    mediaType: "text/markdown",
    size: 20,
    kind: "text",
    text: "```js\nx\n```",
  }]);
  expect(text).toContain("````");
  expect(text).toContain("```js");
});

/** Minimal SSE body builder for the stream parser tests. */
function sseResponse(frames: string[], init?: ResponseInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

async function collect(response: Response): Promise<{ content: string; reasoning: string }> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  let content = "";
  let reasoning = "";
  try {
    await sendChatTurn({
      apiBase: "",
      model: "m",
      messages: [userMessage()],
      signal: new AbortController().signal,
      handlers: {
        onContent(delta) { content += delta; },
        onReasoning(delta) { reasoning += delta; },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { content, reasoning };
}

test("content and reasoning deltas are separated", async () => {
  const result = await collect(sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  expect(result.content).toBe("Hello world");
  expect(result.reasoning).toBe("thinking");
});

test("a frame split across chunk boundaries is still parsed", async () => {
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "split" } }] })}\n\n`;
  const result = await collect(sseResponse([
    frame.slice(0, 12),
    frame.slice(12),
    "data: [DONE]\n\n",
  ]));
  expect(result.content).toBe("split");
});

test("CRLF event separators and comment keep-alives are handled", async () => {
  const result = await collect(sseResponse([
    ": keep-alive\r\n\r\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ]));
  expect(result.content).toBe("crlf");
});

test("an in-stream error frame rejects with the upstream message", async () => {
  const promise = collect(sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
    `data: ${JSON.stringify({ error: { message: "upstream exploded", code: "server_error" } })}\n\n`,
  ]));
  await expect(promise).rejects.toThrow("upstream exploded");
});

test("a non-OK response rejects with the structured error message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: "model not found", code: "model_not_found" } }),
    { status: 404, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  try {
    await sendChatTurn({
      apiBase: "",
      model: "m",
      messages: [userMessage()],
      signal: new AbortController().signal,
      handlers: { onContent() {}, onReasoning() {} },
    });
    throw new Error("expected a rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatStreamError);
    expect((error as ChatStreamError).message).toBe("model not found");
    expect((error as ChatStreamError).code).toBe("model_not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the request targets the management relay, not the data plane", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  let seenHeaders: Record<string, string> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return sseResponse(["data: [DONE]\n\n"]);
  }) as typeof fetch;
  try {
    await sendChatTurn({
      apiBase: "http://127.0.0.1:10199",
      model: "mock/test-model",
      messages: [userMessage()],
      signal: new AbortController().signal,
      handlers: { onContent() {}, onReasoning() {} },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(seenUrl).toBe("http://127.0.0.1:10199/api/chat/completions");
  expect(seenBody.model).toBe("mock/test-model");
  expect(seenBody.stream).toBe(true);
  // No data-plane credential is attached here; the GUI fetch wrapper adds the
  // management token for /api/* paths and nothing else.
  expect(seenHeaders["x-opencodex-api-key"]).toBeUndefined();
});

test("the thinking effort rides the wire as reasoning_effort, with the summary asked for", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as typeof fetch;
  try {
    await sendChatTurn({
      apiBase: "",
      model: "m",
      messages: [userMessage()],
      effort: "xhigh",
      signal: new AbortController().signal,
      handlers: { onContent() {}, onReasoning() {} },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(seenBody.reasoning_effort).toBe("xhigh");
  // Without an explicit summary mode the proxy hides every reasoning item, so the
  // thinking panel would never receive a delta no matter which rung is selected.
  expect(seenBody.reasoning_summary).toBe("auto");
});

test("\"no thinking\" is sent as a real rung, not omitted", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as typeof fetch;
  try {
    await sendChatTurn({
      apiBase: "",
      model: "m",
      messages: [userMessage()],
      effort: "none",
      signal: new AbortController().signal,
      handlers: { onContent() {}, onReasoning() {} },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Omitting it would inherit the provider default — the opposite of the request.
  expect(seenBody.reasoning_effort).toBe("none");
});

test("no effort means no reasoning fields at all", async () => {
  const originalFetch = globalThis.fetch;
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as typeof fetch;
  try {
    await sendChatTurn({
      apiBase: "",
      model: "m",
      messages: [userMessage()],
      signal: new AbortController().signal,
      handlers: { onContent() {}, onReasoning() {} },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect("reasoning_effort" in seenBody).toBe(false);
  expect("reasoning_summary" in seenBody).toBe(false);
});

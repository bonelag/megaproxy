/**
 * Conversation state: send, stream, persist, regenerate, truncate, stop.
 *
 * The hook is driven through a tiny harness rather than a mounted page, so these
 * assertions are about state transitions and persistence, not layout. IndexedDB
 * is absent in this environment, which exercises the in-memory fallback — the
 * same contract, and the path a private-mode browser takes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { resetChatStoreForTests, getChatStore } from "../src/chat/storage";
import { useChatConversations, type ChatConversationsApi } from "../src/chat/use-chat-conversations";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#chat" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetChatStoreForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  resetChatStoreForTests();
});

/** SSE body from a list of content deltas. */
function stubStream(deltas: string[], trailingError?: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
    ...deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`),
    ...(trailingError ? [`data: ${JSON.stringify({ error: { message: trailingError } })}\n\n`] : []),
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Harness {
  api: () => ChatConversationsApi;
  root: Root;
  unmount: () => Promise<void>;
}

async function mountHook(): Promise<Harness> {
  let latest: ChatConversationsApi | null = null;
  function Probe() {
    latest = useChatConversations({ apiBase: "", untitledLabel: "New chat" });
    return null;
  }
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(<Probe />);
  });
  return {
    api: () => {
      if (!latest) throw new Error("hook never rendered");
      return latest;
    },
    root,
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

test("a send creates a conversation, streams the answer, and persists both turns", async () => {
  globalThis.fetch = (async () => stubStream(["Hel", "lo"])) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "hi there", attachments: [], model: "mock/test-model" });
  });

  const active = harness.api().active!;
  expect(active.messages).toHaveLength(2);
  expect(active.messages[0]!.content).toBe("hi there");
  expect(active.messages[1]!.content).toBe("Hello");
  expect(active.messages[1]!.model).toBe("mock/test-model");
  expect(active.messages[1]!.error).toBeUndefined();
  expect(harness.api().streaming).toBe(false);
  // The title is derived from the first user line, not asked of the model.
  expect(active.title).toBe("hi there");

  const summaries = harness.api().summaries;
  expect(summaries).toHaveLength(1);
  expect(summaries[0]!.messageCount).toBe(2);

  const stored = await getChatStore().get(active.id);
  expect(stored?.messages).toHaveLength(2);
  expect(stored?.messages[1]?.content).toBe("Hello");

  await harness.unmount();
});

test("an in-stream error keeps the partial text and reports the failure", async () => {
  globalThis.fetch = (async () => stubStream(["partial"], "upstream exploded")) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "hi", attachments: [], model: "m" });
  });

  const assistant = harness.api().active!.messages[1]!;
  expect(assistant.content).toBe("partial");
  expect(assistant.error).toBe("upstream exploded");
  expect(harness.api().error).toBe("upstream exploded");

  await act(async () => { harness.api().clearError(); });
  expect(harness.api().error).toBeNull();

  await harness.unmount();
});

test("regenerate drops the previous answer and re-runs the last user turn", async () => {
  let call = 0;
  globalThis.fetch = (async () => stubStream([call++ === 0 ? "first" : "second"])) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "ask", attachments: [], model: "m" });
  });
  expect(harness.api().active!.messages[1]!.content).toBe("first");

  await act(async () => {
    await harness.api().regenerate("m");
  });
  const messages = harness.api().active!.messages;
  expect(messages).toHaveLength(2);
  expect(messages[0]!.content).toBe("ask");
  expect(messages[1]!.content).toBe("second");

  await harness.unmount();
});

test("truncateFrom removes the message and everything after it", async () => {
  globalThis.fetch = (async () => stubStream(["answer"])) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "one", attachments: [], model: "m" });
  });
  await act(async () => {
    await harness.api().send({ text: "two", attachments: [], model: "m" });
  });
  expect(harness.api().active!.messages).toHaveLength(4);

  const third = harness.api().active!.messages[2]!.id;
  await act(async () => { harness.api().truncateFrom(third); });
  expect(harness.api().active!.messages).toHaveLength(2);
  expect(harness.api().active!.messages[0]!.content).toBe("one");

  await harness.unmount();
});

test("truncating the first message deletes the conversation", async () => {
  globalThis.fetch = (async () => stubStream(["answer"])) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "only", attachments: [], model: "m" });
  });
  const first = harness.api().active!.messages[0]!.id;
  await act(async () => { harness.api().truncateFrom(first); });
  expect(harness.api().active).toBeNull();
  expect(harness.api().summaries).toHaveLength(0);

  await harness.unmount();
});

test("stop marks the turn as stopped and keeps what streamed", async () => {
  // A stream that never closes on its own, so only the abort can end it.
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "streamed" } }] })}\n\n`,
        ));
        signal?.addEventListener("abort", () => {
          try { controller.error(new Error("aborted")); } catch { /* already closed */ }
        });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const harness = await mountHook();
  let sending: Promise<void>;
  await act(async () => {
    sending = harness.api().send({ text: "hold", attachments: [], model: "m" });
    // Let the first delta land before stopping.
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  await act(async () => {
    harness.api().stop();
    await sending!;
  });

  const assistant = harness.api().active!.messages[1]!;
  expect(assistant.content).toBe("streamed");
  expect(assistant.stopped).toBe(true);
  // A user-initiated stop is not an error banner.
  expect(harness.api().error).toBeNull();
  expect(harness.api().streaming).toBe(false);

  await harness.unmount();
});

test("rename and delete update the rail and the store", async () => {
  globalThis.fetch = (async () => stubStream(["answer"])) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "original", attachments: [], model: "m" });
  });
  const id = harness.api().activeId!;

  await act(async () => { harness.api().renameConversation(id, "renamed"); });
  expect(harness.api().summaries[0]!.title).toBe("renamed");
  expect((await getChatStore().get(id))?.title).toBe("renamed");

  await act(async () => { harness.api().deleteConversation(id); });
  expect(harness.api().summaries).toHaveLength(0);
  expect(await getChatStore().get(id)).toBeNull();

  await harness.unmount();
});

test("the system prompt is sent ahead of the transcript", async () => {
  let seenBody: { messages?: Array<{ role: string; content: unknown }> } = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as typeof seenBody;
    return stubStream(["ok"]);
  }) as typeof fetch;
  const harness = await mountHook();
  await act(async () => {
    await harness.api().send({ text: "hi", attachments: [], model: "m", systemPrompt: "be brief" });
  });
  expect(seenBody.messages?.[0]).toEqual({ role: "system", content: "be brief" });
  expect(seenBody.messages?.[1]).toEqual({ role: "user", content: "hi" });

  await harness.unmount();
});

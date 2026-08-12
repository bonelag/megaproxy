/**
 * The Chat page, mounted.
 *
 * The unit suites cover the wire, the renderer, and the store; what is left is
 * the part only a real mount can show: the composer reaches the relay, the
 * answer renders as highlighted markdown with a copy button, the model picker
 * and the thinking-effort menu change what is sent, and the history popover
 * picks up the new thread.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Chat from "../src/chat/ChatPage";
import { LanguageProvider } from "../src/i18n/provider";
import { resetChatStoreForTests } from "../src/chat/storage";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const MODEL_ROWS = [
  { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", disabled: false, native: true },
  { provider: "mock", id: "test-model", namespaced: "mock/test-model", disabled: false, inputModalities: ["text"] },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#chat" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
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

function sse(answer: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
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

interface Mounted {
  container: HTMLElement;
  root: Root;
  turns: Array<Record<string, unknown>>;
  unmount: () => Promise<void>;
}

async function mountChat(answer = "Here:\n\n```ts\nconst a = 1;\n```"): Promise<Mounted> {
  const turns: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/models")) return Response.json(MODEL_ROWS);
    if (url.endsWith("/api/chat/completions")) {
      turns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse(answer);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(
      <LanguageProvider>
        <Chat apiBase="" />
      </LanguageProvider>,
    );
  });
  // The model list loads on a deferred tick inside the resource layer.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return {
    container: container as unknown as HTMLElement,
    root,
    turns,
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

function setTextarea(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button"))
    .find(button => button.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

/**
 * Send and Stop are the same circular icon button with no text, so they are
 * addressed by accessible name — which is also the only way a screen reader
 * reaches them.
 */
function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
}

test("the empty state invites a first message and the composer is enabled", async () => {
  const mounted = await mountChat();
  expect(mounted.container.textContent).toContain("Start a conversation");
  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  expect(input).toBeTruthy();
  // A model resolved from /api/models, so the composer is not in its disabled state.
  expect(input.disabled).toBe(false);
  expect(input.getAttribute("placeholder")).toBe("Send a message…");
  // The dock caption and the header's model pill both name the resolved model.
  expect(mounted.container.textContent).toContain("Model list is filtered from connected providers.");
  expect(mounted.container.querySelector(".chat-model-trigger-slug")?.textContent).toBe("gpt-5.6-sol");
  await mounted.unmount();
});

test("sending renders the user turn and the assistant's highlighted markdown", async () => {
  const mounted = await mountChat();
  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "show me a snippet"); });

  const send = buttonByLabel(mounted.container, "Send")!;
  expect(send.disabled).toBe(false);
  await act(async () => {
    send.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });

  // The turn reached the relay with the resolved model, not an empty slug.
  expect(mounted.turns).toHaveLength(1);
  expect(mounted.turns[0]!.model).toBe("gpt-5.6-sol");

  const userBubble = mounted.container.querySelector(".chat-msg--user .chat-msg-text");
  expect(userBubble?.textContent).toBe("show me a snippet");

  const assistant = mounted.container.querySelector(".chat-msg--assistant .chat-markdown");
  expect(assistant).toBeTruthy();
  expect(assistant!.innerHTML).toContain("chat-code");
  expect(assistant!.textContent).toContain("const a = 1;");

  // Every code block carries its own copy affordance.
  expect(mounted.container.querySelector("[data-chat-copy]")).toBeTruthy();

  // And the thread now exists in the history popover.
  await act(async () => { buttonByText(mounted.container, "History")!.click(); });
  expect(mounted.container.querySelector(".chat-history-title")?.textContent).toBe("show me a snippet");

  await mounted.unmount();
});

test("the composer clears after a send and refuses an empty one", async () => {
  const mounted = await mountChat();
  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  expect(buttonByLabel(mounted.container, "Send")!.disabled).toBe(true);

  await act(async () => { setTextarea(input, "hi"); });
  await act(async () => {
    buttonByLabel(mounted.container, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });

  expect(mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!.value).toBe("");
  expect(buttonByLabel(mounted.container, "Send")!.disabled).toBe(true);
  await mounted.unmount();
});

test("a failing turn surfaces the error without losing the transcript", async () => {
  const mounted = await mountChat();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/models")) return Response.json(MODEL_ROWS);
    return Response.json({ error: { message: "provider refused the turn" } }, { status: 502 });
  }) as typeof fetch;

  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "will fail"); });
  await act(async () => {
    buttonByLabel(mounted.container, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });

  expect(mounted.container.textContent).toContain("provider refused the turn");
  // The user's own turn is still on screen.
  expect(mounted.container.querySelector(".chat-msg--user .chat-msg-text")?.textContent).toBe("will fail");
  await mounted.unmount();
});

test("the system prompt panel toggles and is sent with the next turn", async () => {
  const mounted = await mountChat();
  await act(async () => { buttonByText(mounted.container, "System prompt")!.click(); });
  const systemInput = mounted.container.querySelector<HTMLTextAreaElement>("#chat-system-prompt")!;
  expect(systemInput).toBeTruthy();
  await act(async () => { setTextarea(systemInput, "be terse"); });

  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "hello"); });
  await act(async () => {
    buttonByLabel(mounted.container, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });

  const messages = mounted.turns[0]!.messages as Array<{ role: string; content: unknown }>;
  expect(messages[0]).toEqual({ role: "system", content: "be terse" });
  await mounted.unmount();
});

test("the model picker groups by provider and switching it changes the sent model", async () => {
  const mounted = await mountChat();
  await act(async () => { mounted.container.querySelector<HTMLButtonElement>(".chat-model-trigger")!.click(); });

  const groups = mounted.container.querySelectorAll(".chat-model-group");
  expect(groups).toHaveLength(2);
  // Every group carries its own count badge.
  expect([...mounted.container.querySelectorAll(".chat-model-group-count")].map(node => node.textContent))
    .toEqual(["1", "1"]);

  // Search narrows to one provider's card, and the card shows the routing slug.
  const search = mounted.container.querySelector<HTMLInputElement>(".chat-model-search-input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "mock");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  const cards = mounted.container.querySelectorAll(".chat-model-card");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.querySelector(".chat-model-card-slug")?.textContent).toBe("mock/test-model");

  await act(async () => { (cards[0] as HTMLButtonElement).click(); });
  // Picking closes the panel and repoints the header pill.
  expect(mounted.container.querySelector(".chat-model-panel")).toBeNull();
  expect(mounted.container.querySelector(".chat-model-trigger-slug")?.textContent).toBe("mock/test-model");

  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "route me"); });
  await act(async () => {
    buttonByLabel(mounted.container, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(mounted.turns[0]!.model).toBe("mock/test-model");

  await mounted.unmount();
});

test("the thinking-effort pick reaches the wire", async () => {
  const mounted = await mountChat();
  // Default rung is Low, shown on the toolbar pill.
  const pill = mounted.container.querySelector<HTMLButtonElement>(".chat-tool-pill")!;
  expect(pill.textContent).toContain("Low");

  await act(async () => { pill.click(); });
  const rows = [...mounted.container.querySelectorAll<HTMLButtonElement>(".chat-effort-menu .chat-menu-row")];
  expect(rows.map(row => row.querySelector(".chat-menu-label")?.textContent))
    .toEqual(["No thinking", "Low", "Medium", "High", "Extra high", "Max"]);
  // The selected rung is the checked radio, not just a styled row.
  expect(rows.find(row => row.getAttribute("aria-checked") === "true")?.textContent).toContain("Low");

  await act(async () => { rows[4]!.click(); });
  expect(mounted.container.querySelector(".chat-effort-menu")).toBeNull();
  expect(mounted.container.querySelector(".chat-tool-pill")!.textContent).toContain("Extra high");

  const input = mounted.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "think hard"); });
  await act(async () => {
    buttonByLabel(mounted.container, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });

  expect(mounted.turns[0]!.reasoning_effort).toBe("xhigh");
  expect(mounted.turns[0]!.reasoning_summary).toBe("auto");
  // The answer records which rung produced it.
  expect(mounted.container.querySelector(".chat-msg-effort")?.textContent).toContain("Extra high");

  await mounted.unmount();
});

test("the Image mode segment is present for parity but inert", async () => {
  const mounted = await mountChat();
  const segments = [...mounted.container.querySelectorAll<HTMLButtonElement>(".chat-mode-seg")];
  expect(segments.map(segment => segment.textContent)).toEqual(["Chat", "Image"]);
  expect(segments[0]!.getAttribute("aria-pressed")).toBe("true");
  // Image generation is out of scope for this tab; the control must not pretend.
  expect(segments[1]!.disabled).toBe(true);
  await mounted.unmount();
});

test("no models available disables the composer and says so", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/models")) return Response.json([]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(<LanguageProvider><Chat apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

  const input = (container as unknown as HTMLElement).querySelector<HTMLTextAreaElement>(".chat-input")!;
  expect(input.disabled).toBe(true);
  expect((container as unknown as HTMLElement).textContent).toContain("No models are available");

  await act(async () => { root.unmount(); });
});

test("a model list failure shows a retry affordance rather than an empty page", async () => {
  globalThis.fetch = (async () => Response.json({ error: "catalog unavailable" }, { status: 503 })) as typeof fetch;
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(<LanguageProvider><Chat apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

  const host = container as unknown as HTMLElement;
  expect(host.textContent).toContain("catalog unavailable");
  expect(buttonByText(host, "Retry")).toBeTruthy();

  await act(async () => { root.unmount(); });
});

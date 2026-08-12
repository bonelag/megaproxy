/**
 * Streaming behavior in the transcript.
 *
 * The interesting property is incremental: the answer must appear while the
 * stream is open, not only once it settles. A regression here (awaiting the
 * whole body, or flushing only at the end) would still pass every other test in
 * this suite, because the final state is identical.
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
  { provider: "mock", id: "test-model", namespaced: "mock/test-model", disabled: false },
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

function setTextarea(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

/**
 * Send and Stop are the same circular icon button with no text, so they are
 * addressed by accessible name — which is also the only way a screen reader
 * reaches them.
 */
function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
}

test("the answer paints while the stream is still open", async () => {
  /** Resolved once the first delta is on the wire; released by the test. */
  let releaseSecondDelta: (() => void) | null = null;
  const secondDelta = new Promise<void>(resolve => { releaseSecondDelta = resolve; });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/models")) return Response.json(MODEL_ROWS);
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
        controller.enqueue(frame({ choices: [{ delta: { role: "assistant", content: "" } }] }));
        controller.enqueue(frame({ choices: [{ delta: { content: "first half" } }] }));
        await secondDelta;
        controller.enqueue(frame({ choices: [{ delta: { content: " second half" } }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

  const host = container as unknown as HTMLElement;
  const input = host.querySelector<HTMLTextAreaElement>(".chat-input")!;
  await act(async () => { setTextarea(input, "stream please"); });

  await act(async () => {
    buttonByLabel(host, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  // Mid-stream: the first delta is rendered and Stop is offered instead of Send.
  expect(host.textContent).toContain("first half");
  expect(host.textContent).not.toContain("second half");
  expect(buttonByLabel(host, "Stop")).toBeTruthy();
  expect(buttonByLabel(host, "Send")).toBeUndefined();

  await act(async () => {
    releaseSecondDelta!();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  expect(host.textContent).toContain("first half second half");
  expect(buttonByLabel(host, "Send")).toBeTruthy();
  expect(buttonByLabel(host, "Stop")).toBeUndefined();

  await act(async () => { root.unmount(); });
});

test("reasoning deltas render behind a disclosure, separate from the answer", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/models")) return Response.json(MODEL_ROWS);
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "weighing options" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "the answer" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

  const host = container as unknown as HTMLElement;
  await act(async () => { setTextarea(host.querySelector<HTMLTextAreaElement>(".chat-input")!, "think"); });
  await act(async () => {
    buttonByLabel(host, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  // Once the answer exists the thinking text collapses again: it is context, not
  // the result. The panel names the finished state rather than "Thinking…".
  expect(host.textContent).toContain("the answer");
  expect(host.textContent).not.toContain("weighing options");
  const toggle = host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("Thought process");

  await act(async () => { toggle.click(); });
  // Rendered through the same escaped markdown path as the answer.
  expect(host.querySelector(".chat-reasoning-body .chat-markdown")?.textContent).toContain("weighing options");

  await act(async () => { root.unmount(); });
});

test("thinking is shown live, then folds away when the answer starts", async () => {
  /** Held until the test releases it, so the thinking-only phase is observable. */
  let releaseAnswer: (() => void) | null = null;
  const answer = new Promise<void>(resolve => { releaseAnswer = resolve; });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/models")) return Response.json(MODEL_ROWS);
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
        controller.enqueue(frame({ choices: [{ delta: { role: "assistant", content: "" } }] }));
        controller.enqueue(frame({ choices: [{ delta: { reasoning_content: "step one" } }] }));
        await answer;
        controller.enqueue(frame({ choices: [{ delta: { content: "done" } }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

  const host = container as unknown as HTMLElement;
  await act(async () => { setTextarea(host.querySelector<HTMLTextAreaElement>(".chat-input")!, "think"); });
  await act(async () => {
    buttonByLabel(host, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  // Thinking phase: the panel opens itself, because there is nothing else to look
  // at yet. A long silent phase must not read as a stalled request.
  const toggle = host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toContain("Thinking…");
  expect(host.querySelector(".chat-reasoning.is-live")).toBeTruthy();
  expect(host.querySelector(".chat-reasoning-body")?.textContent).toContain("step one");

  await act(async () => {
    releaseAnswer!();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  expect(host.textContent).toContain("done");
  expect(host.querySelector(".chat-reasoning.is-live")).toBeNull();
  expect(host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!.getAttribute("aria-expanded")).toBe("false");

  await act(async () => { root.unmount(); });
});

test("an explicit disclosure pick survives the answer arriving", async () => {
  let releaseAnswer: (() => void) | null = null;
  const answer = new Promise<void>(resolve => { releaseAnswer = resolve; });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/models")) return Response.json(MODEL_ROWS);
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
        controller.enqueue(frame({ choices: [{ delta: { role: "assistant", content: "" } }] }));
        controller.enqueue(frame({ choices: [{ delta: { reasoning_content: "step one" } }] }));
        await answer;
        controller.enqueue(frame({ choices: [{ delta: { content: "done" } }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

  const host = container as unknown as HTMLElement;
  await act(async () => { setTextarea(host.querySelector<HTMLTextAreaElement>(".chat-input")!, "think"); });
  await act(async () => {
    buttonByLabel(host, "Send")!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  // The user closes it mid-thought; the auto-fold must not reopen or re-close it.
  await act(async () => { host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!.click(); });
  expect(host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!.getAttribute("aria-expanded")).toBe("false");

  await act(async () => {
    releaseAnswer!();
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  expect(host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!.getAttribute("aria-expanded")).toBe("false");

  // And reopening it keeps it open for the life of the message.
  await act(async () => { host.querySelector<HTMLButtonElement>(".chat-reasoning-toggle")!.click(); });
  expect(host.querySelector(".chat-reasoning-body")?.textContent).toContain("step one");

  await act(async () => { root.unmount(); });
});

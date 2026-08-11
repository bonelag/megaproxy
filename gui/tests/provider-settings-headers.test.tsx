import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function provider(headers?: Record<string, string>): WorkspaceItem {
  return {
    name: "custom-provider",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    note: "before",
    hasHeaders: !!headers && Object.keys(headers).length > 0,
    headers,
  } as WorkspaceItem;
}

async function mountSettings(item: WorkspaceItem): Promise<{
  root: Root;
  container: HTMLElement;
  patches: ProviderUpdatePatch[];
}> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={item}
          onUpdateProvider={async (_name, patch) => {
            patches.push(patch);
            return { ok: true };
          }}
        />
      </LanguageProvider>,
    );
  });
  return { root, container, patches };
}

async function save(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof testWindow.HTMLTextAreaElement
    ? testWindow.HTMLTextAreaElement.prototype
    : testWindow.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

test("settings seeds full UA and header rows from item.headers", async () => {
  const { root, container } = await mountSettings(provider({
    "User-Agent": "claude-cli/2.1.220 (external, cli)",
    "X-Test": "1",
  }));
  const ua = container.querySelector<HTMLInputElement>("#pws-headers-custom-provider-ua")!;
  expect(ua.value).toBe("claude-cli/2.1.220 (external, cli)");
  const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Header name"]');
  const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Value"]');
  expect(nameInput?.value).toBe("X-Test");
  expect(valueInput?.value).toBe("1");
  await act(async () => { root.unmount(); });
});

test("settings save without touching headers omits headers from PATCH", async () => {
  const { root, container, patches } = await mountSettings(provider({
    "User-Agent": "seeded-ua",
    "X-Keep": "1",
  }));
  const note = container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!;
  await act(async () => {
    setInput(note, "after");
  });
  await save(container);
  expect(patches).toHaveLength(1);
  expect(Object.hasOwn(patches[0]!, "headers")).toBe(false);
  expect(Object.hasOwn(patches[0]!, "headersReplace")).toBe(false);
  expect(patches[0]?.note).toBe("after");
  await act(async () => { root.unmount(); });
});

test("settings save with UA + row sends headersReplace full set", async () => {
  const { root, container, patches } = await mountSettings(provider());
  const ua = container.querySelector<HTMLInputElement>("#pws-headers-custom-provider-ua")!;
  expect(ua).toBeTruthy();
  await act(async () => {
    setInput(ua, "claude-cli/2.1.220 (external, cli)");
  });

  const addBtn = Array.from(container.querySelectorAll("button")).find(b => /\bAdd\b/.test(b.textContent ?? ""));
  expect(addBtn).toBeTruthy();
  await act(async () => {
    addBtn!.click();
  });

  const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Header name"]');
  const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Value"]');
  expect(nameInput).toBeTruthy();
  expect(valueInput).toBeTruthy();
  await act(async () => {
    setInput(nameInput!, "X-Test");
    setInput(valueInput!, "1");
  });

  await save(container);
  expect(patches).toHaveLength(1);
  expect(patches[0]?.headersReplace).toBe(true);
  expect(patches[0]?.headers).toEqual({
    "User-Agent": "claude-cli/2.1.220 (external, cli)",
    "X-Test": "1",
  });
  await act(async () => { root.unmount(); });
});

test("settings clear headers sends headers: null", async () => {
  const { root, container, patches } = await mountSettings(provider({
    "User-Agent": "seeded-ua",
    "X-Keep": "1",
  }));
  const clearBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Clear");
  expect(clearBtn).toBeTruthy();
  await act(async () => {
    clearBtn!.click();
  });
  await save(container);
  expect(patches).toHaveLength(1);
  expect(patches[0]?.headers).toBeNull();
  expect(Object.hasOwn(patches[0]!, "headersReplace")).toBe(false);
  await act(async () => { root.unmount(); });
});

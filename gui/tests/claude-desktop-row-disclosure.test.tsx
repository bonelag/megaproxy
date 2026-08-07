import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Row disclosure inside a family pane: a model row is a one-line summary until opened.
 *
 * Mounted rather than source-shape, because the failures worth catching are stateful —
 * most importantly that collapsing a row must not discard a pending move destination,
 * and that the two 1M toggles stay coupled (prefer requires support).
 *
 * `destinations` is page-level state keyed by route, and this test is the only thing
 * proving nobody moves it into the row component later.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

const MODELS = [
  {
    route: "prov/first",
    label: "First Model",
    available: true,
    contextWindow: 200_000,
    effortSupported: true,
    supports1m: false,
    prefer1m: false,
    autoSupports1m: false,
    assignment: { family: "opus", alias: "claude-opus-first" },
  },
  {
    route: "prov/second",
    label: "Second Model",
    available: true,
    contextWindow: 1_000_000,
    effortSupported: false,
    supports1m: true,
    prefer1m: true,
    autoSupports1m: true,
    assignment: { family: "opus", alias: "claude-opus-second" },
  },
];

function payload() {
  return {
    profile: {
      version: 1,
      assignments: Object.fromEntries(MODELS.map(m => [m.route, m.assignment])),
      defaults: { opus: "prov/first", fable: null, sonnet: null, haiku: null },
      chatTabEnabled: true,
    },
    models: MODELS,
    rendered: [],
    port: 10100,
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const body = String(url).includes("/status")
        ? { applied: true, appliedAt: null, stale: false, health: { lastRequestAt: null, requestCount: 0, errorCount: 0 } }
        : payload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });

  // Use the GLOBAL document (which beforeEach points at testWindow): React reads globals,
  // so a container created off the raw window object is not the document it renders into,
  // and synthetic events never reach the tree.
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

function railRow(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button.claudecode-workspace-rail-row"))
    .find(button => (button.querySelector(".claudecode-workspace-rail-name")?.textContent ?? "") === name);
  if (!found) throw new Error(`rail row not found: ${name}`);
  return found as unknown as HTMLButtonElement;
}

/** Row-disclosure tests all work inside the Opus pane; category selection is covered elsewhere. */
async function mount() {
  // Import AFTER beforeEach installed the globals: a module-level import binds react-dom
  // to whatever document existed at load time, and synthetic events then never reach the
  // tree React actually rendered into.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeDesktop apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  await click(railRow("Opus"));
}

function row(label: string): HTMLElement {
  const found = Array.from(container.querySelectorAll("article.claude-model-card"))
    .find(article => (article.querySelector(".claude-model-names strong")?.textContent ?? "") === label);
  if (!found) throw new Error(`row not found: ${label}`);
  return found as unknown as HTMLElement;
}

function summary(label: string): HTMLButtonElement {
  return row(label).querySelector("button.claude-model-summary") as unknown as HTMLButtonElement;
}

/** The 1M toggles are the only checkboxes inside a row body, in support→prefer order. */
function toggles(label: string): { supports: HTMLInputElement; prefer: HTMLInputElement } {
  const inputs = Array.from(row(label).querySelectorAll(".claude-model-settings input[type=checkbox]"));
  return {
    supports: inputs[0] as unknown as HTMLInputElement,
    prefer: inputs[1] as unknown as HTMLInputElement,
  };
}

async function flip(input: HTMLInputElement, next: boolean) {
  if (input.checked === next) throw new Error(`toggle already ${next}`);
  // React installs its own `checked` tracker on the instance, so assigning the property
  // and dispatching by hand is swallowed as "no change". A real click is what the browser
  // does anyway, and React derives checkbox onChange from it.
  await act(async () => { input.click(); });
}

test("a non-default row starts collapsed with no edit controls in the DOM", async () => {
  await mount();
  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  expect(second.querySelector(".claude-model-body")).toBeNull();
  expect(second.querySelector(".claude-alias")).toBeNull();
  expect(second.querySelector("input[type=radio]")).toBeNull();
  expect(second.querySelector("select")).toBeNull();
});

// The row a user came to change should not need a second click to reach.
test("the family's resolved default starts open", async () => {
  await mount();
  expect(summary("First Model").getAttribute("aria-expanded")).toBe("true");
  expect(row("First Model").querySelector(".claude-alias")?.textContent).toBe("claude-opus-first");
});

test("opening a row reveals alias, default radio, 1M toggles and the move control", async () => {
  await mount();
  await click(summary("Second Model"));

  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("true");
  expect(second.querySelector(".claude-alias")?.textContent).toBe("claude-opus-second");
  expect(second.querySelector("input[type=radio]")).not.toBeNull();
  expect(second.querySelectorAll(".claude-model-settings input[type=checkbox]")).toHaveLength(2);
  expect(second.querySelector("select")).not.toBeNull();
});

// Triage information must never go behind the fold: context, 1M and effort are what you
// scan to decide which model becomes the family default.
test("context, 1M chips and effort stay readable while collapsed", async () => {
  await mount();
  const second = row("Second Model");
  expect(second.querySelector(".claude-model-context")?.textContent).toContain("1M");
  expect(second.querySelector(".claude-effort-badge")).not.toBeNull();
  expect(second.querySelector(".claude-1m-chip")).not.toBeNull();
});

test("the family default is marked in the collapsed summary", async () => {
  await mount();
  expect(row("First Model").querySelector(".claude-row-default")?.textContent).toBe("Default");
  expect(row("Second Model").querySelector(".claude-row-default")).toBeNull();
});

// The regression the design predicts but does not guarantee: `destinations` is page
// state keyed by route, so unmounting the row must not lose a pending selection. If
// someone later moves that state into the row, this fails.
test("a pending move destination survives collapsing and reopening the row", async () => {
  await mount();
  await click(summary("Second Model"));

  const select = row("Second Model").querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    select.value = "sonnet";
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as never);
  });

  await click(summary("Second Model"));
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  await click(summary("Second Model"));

  const reopened = row("Second Model").querySelector("select") as unknown as HTMLSelectElement;
  expect(reopened.value).toBe("sonnet");
});

test("a collapsed row is still draggable", async () => {
  await mount();
  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("draggable")).toBe("true");
});

test("a 1M-capable row shows the 1M chip; a below-threshold row does not", async () => {
  await mount();
  // Second Model is 1_000_000 (autoSupports1m) — the chip shows in the collapsed summary.
  // First Model is 200_000 — a context number alone is not eligibility, so no chip.
  expect(row("Second Model").querySelector(".claude-1m-chip")?.textContent).toBe("1M");
  expect(row("First Model").querySelector(".claude-1m-chip")).toBeNull();
});

// A 1M-capable model opens with both pins on, mirroring what the writer emits.
test("1M toggles reflect the effective pins, with prefer gated behind support", async () => {
  await mount();
  await click(summary("Second Model"));
  const second = toggles("Second Model");
  expect(second.supports.checked).toBe(true);
  expect(second.prefer.checked).toBe(true);
  expect(second.prefer.disabled).toBe(false);

  const first = toggles("First Model");
  expect(first.supports.checked).toBe(false);
  expect(first.prefer.checked).toBe(false);
  // Preference without support is meaningless: the writer ignores it, so the control
  // must not look live.
  expect(first.prefer.disabled).toBe(true);
});

test("turning support off also clears preference", async () => {
  await mount();
  await click(summary("Second Model"));
  await flip(toggles("Second Model").supports, false);

  const after = toggles("Second Model");
  expect(after.supports.checked).toBe(false);
  expect(after.prefer.checked).toBe(false);
  expect(after.prefer.disabled).toBe(true);
  // The chips follow the pins, so a disabled model stops advertising 1M.
  expect(row("Second Model").querySelector(".claude-1m-chip")).toBeNull();
});

// Forcing support on a model the catalog never reported as 1M is the operator override
// the old read-only chip could not express.
test("support can be forced on a below-threshold model, and preference follows it", async () => {
  await mount();
  await flip(toggles("First Model").supports, true);

  let current = toggles("First Model");
  expect(current.supports.checked).toBe(true);
  expect(current.prefer.disabled).toBe(false);
  // Preference defaults to support — the same rule resolveDesktop1mFlags applies server-side,
  // so the toggles cannot disagree with what apply writes.
  expect(current.prefer.checked).toBe(true);
  expect(row("First Model").querySelector(".claude-1m-chip-prefer")).not.toBeNull();

  // Support without the 1M default is a real combination, so preference must be
  // independently switchable once support is on.
  await flip(current.prefer, false);
  current = toggles("First Model");
  expect(current.supports.checked).toBe(true);
  expect(current.prefer.checked).toBe(false);
  expect(row("First Model").querySelector(".claude-1m-chip-prefer")).toBeNull();
  expect(row("First Model").querySelector(".claude-1m-chip")).not.toBeNull();
});

test("editing a 1M pin marks the profile dirty", async () => {
  await mount();
  expect(container.querySelector(".claude-dirty.active")).toBeNull();
  await flip(toggles("First Model").supports, true);
  expect(container.querySelector(".claude-dirty.active")).not.toBeNull();
});

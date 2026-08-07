import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Desktop settings use the same rail-and-pane layout as Claude Code: one category per
 * rail row instead of four stacked collapsibles. Mounted rather than source-shape,
 * because the interesting failures are interactive — selecting a category, dropping a
 * model onto a family pane, and keeping the save bar honest across panes.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function model(route: string, label: string, family: string, available = true) {
  return {
    route,
    label,
    available,
    contextWindow: 200_000,
    effortSupported: true,
    supports1m: false,
    prefer1m: false,
    autoSupports1m: false,
    assignment: { family, alias: `alias-${label}` },
  };
}

// Eight available models so the lane pager and the search input are both in play
// (LANE_PAGE = 6, LANE_SEARCH_MIN = 4), plus one unavailable model that must stay hidden.
const MODELS = [
  ...Array.from({ length: 7 }, (_, i) => model(`prov/opus-${i}`, `Opus Model ${i}`, "opus")),
  model("prov/only-sonnet", "Sonnet Model", "sonnet"),
  model("prov/dead", "Dead Model", "opus", false),
];

function payload() {
  return {
    profile: {
      version: 1,
      assignments: Object.fromEntries(MODELS.map(m => [m.route, m.assignment])),
      defaults: { opus: "prov/opus-0", fable: null, sonnet: "prov/only-sonnet", haiku: null },
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
  // and synthetic input events never reach the tree.
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
}

function railRow(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button.claudecode-workspace-rail-row"))
    .find(button => (button.querySelector(".claudecode-workspace-rail-name")?.textContent ?? "") === name);
  if (!found) throw new Error(`rail row not found: ${name}`);
  return found as unknown as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

async function selectPane(name: string) {
  await click(railRow(name));
}

test("categories render as rail rows, General first and the families in tier order", async () => {
  await mount();
  expect(container.querySelector(".claudecode-workspace-root")).not.toBeNull();
  // The old collapsible family stack is gone.
  expect(container.querySelector(".ocx-group-stack")).toBeNull();
  const names = Array.from(container.querySelectorAll(".claudecode-workspace-rail-name")).map(n => n.textContent);
  expect(names).toEqual(["General", "Opus", "Fable", "Sonnet", "Haiku", "Import / export"]);
});

test("General is the initial pane and owns the Chat tab toggle", async () => {
  await mount();
  expect(railRow("General").getAttribute("aria-current")).toBe("true");
  const toggle = container.querySelector(".setting-row input[type=checkbox]") as unknown as HTMLInputElement;
  expect(toggle).not.toBeNull();
  // The server sends chatTabEnabled: true, so the control opens on.
  expect(toggle.checked).toBe(true);
});

test("selecting a family pane shows only that family's models", async () => {
  await mount();
  await selectPane("Sonnet");
  const labels = Array.from(container.querySelectorAll(".claude-model-names strong")).map(n => n.textContent);
  expect(labels).toEqual(["Sonnet Model"]);
});

// Unavailable models cannot be assigned or made default, so a wall of dead rows was
// noise. They stay in the profile — the note is what proves they were not dropped.
test("unavailable models are hidden and reported as a count", async () => {
  await mount();
  await selectPane("Opus");
  const labels = Array.from(container.querySelectorAll(".claude-model-names strong")).map(n => n.textContent);
  expect(labels).not.toContain("Dead Model");
  expect(container.querySelector(".claude-hidden-note")?.textContent).toContain("1");
});

test("the rail count reports available models only", async () => {
  await mount();
  // Seven available Opus models; the eighth is unavailable and hidden.
  expect(railRow("Opus").parentElement).not.toBeNull();
  await selectPane("Opus");
  expect(container.querySelector(".ccw-main-title .count")?.textContent).toBe("7");
});

// The pane owns the drop target the old <section> used to. Dropping must still move the
// model even though the destination family is not the visible pane.
test("dropping a model on a family pane moves it there", async () => {
  await mount();
  await selectPane("Fable");
  const pane = container.querySelector(".claude-family-pane")!;

  await act(async () => {
    const event = new testWindow.Event("drop", { bubbles: true }) as unknown as Event & { dataTransfer: unknown };
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => "prov/opus-0" } });
    pane.dispatchEvent(event as never);
  });

  expect(container.querySelector(".ccw-main-title .count")?.textContent).toBe("1");
  const labels = Array.from(container.querySelectorAll(".claude-model-names strong")).map(n => n.textContent);
  expect(labels).toEqual(["Opus Model 0"]);
});

// Search narrows the RENDERED list only. If the rail count followed the filter, a user
// typing in the box would believe models had been unassigned.
test("the pane count ignores the search", async () => {
  await mount();
  await selectPane("Opus");
  expect(container.querySelector(".ccw-main-title .count")?.textContent).toBe("7");

  const search = container.querySelector("input.claude-lane-search") as unknown as HTMLInputElement;
  await act(async () => {
    // React caches the last value it wrote on an internal tracker, so a plain
    // `search.value = …` leaves the tracker holding the same value and onChange never
    // fires. Writing through the prototype setter and clearing the tracker is what makes
    // a synthetic edit look like a real one.
    const proto = Object.getPrototypeOf(search) as object;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(search, "Opus Model 3");
    (search as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue("");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });

  expect(container.querySelector(".ccw-main-title .count")?.textContent).toBe("7");
  const labels = Array.from(container.querySelectorAll(".claude-model-names strong")).map(n => n.textContent);
  expect(labels).toEqual(["Opus Model 3"]);
});

// Save is profile-wide, so unlike Claude Code it must stay reachable from every pane —
// including the read-only-looking import/export one.
test("the save bar is present on every pane and starts clean", async () => {
  await mount();
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("Profile is up to date");
  await selectPane("Import / export");
  expect(container.querySelector(".claudecode-workspace-save")).not.toBeNull();
  expect(container.querySelector(".claude-dirty.active")).toBeNull();
});

test("flipping the Chat tab toggle marks the profile dirty", async () => {
  await mount();
  const toggle = container.querySelector(".setting-row input[type=checkbox]") as unknown as HTMLInputElement;
  // Click rather than assigning `checked`: React tracks the property on the instance and
  // treats a direct write as no change.
  await act(async () => { toggle.click(); });
  expect(toggle.checked).toBe(false);
  expect(container.querySelector(".claude-dirty.active")).not.toBeNull();
});

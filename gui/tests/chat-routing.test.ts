/**
 * `#chat` is a first-class page, not a Models sub-tab.
 *
 * The distinction matters because Combos/Routing/Compatibility all fold INTO
 * `#models` by design, and a reader could reasonably assume Chat did too. It
 * does not: it is its own sidebar row and its own hash, so a bookmark or a
 * refresh on `#chat` must land on Chat rather than being normalized to Models.
 */
import { expect, test } from "bun:test";
import { VALID_PAGES, hashBelongsToPage, readPageFromHash, resolveAppHashChange } from "../src/app-routing";

test("chat is a valid page and resolves from its own hash", () => {
  expect(VALID_PAGES.has("chat")).toBe(true);
  expect(readPageFromHash("chat")).toBe("chat");
  expect(readPageFromHash("#chat")).toBe("chat");
  expect(hashBelongsToPage("chat", "chat")).toBe(true);
  expect(resolveAppHashChange("chat")).toEqual({ page: "chat", replaceTo: null });
});

test("chat owns no sub-tabs, so a sub-hash is normalized away", () => {
  // Unlike Models, Chat has no tab strip; conversation selection is state, not a
  // route, because a thread id in the URL would outlive the deleted thread.
  expect(resolveAppHashChange("chat/anything")).toEqual({ page: "chat", replaceTo: "chat" });
  expect(hashBelongsToPage("chat/anything", "chat")).toBe(false);
});

test("chat is not folded into models the way the legacy models tabs are", () => {
  expect(readPageFromHash("combos")).toBe("models");
  expect(readPageFromHash("routing")).toBe("models");
  expect(readPageFromHash("chat")).not.toBe("models");
});

test("the page id, nav row, label map, and render switch all agree", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  // A page present in one of these four places and missing from another is a
  // blank surface or an untranslated sidebar row, neither of which type-checks
  // its way to a failure.
  expect(app).toContain('chat: "nav.chat"');
  expect(app).toContain('{ id: "chat", tkey: "nav.chat"');
  expect(app).toContain('page === "chat" && <Chat');
});

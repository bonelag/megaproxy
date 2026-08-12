/**
 * Chat markdown rendering — the security-relevant surface.
 *
 * The rendered string goes into `dangerouslySetInnerHTML` inside the dashboard
 * origin, which holds the management session. So the tests that matter most are
 * the ones asserting model-authored HTML and hostile URL schemes cannot survive
 * the render.
 */
import { expect, test } from "bun:test";
import { collectCodeLanguages, escapeHtml, renderMarkdown } from "../src/chat/markdown";
import { resolveLang } from "../src/chat/highlight";

const options = { highlighter: null, copyLabel: "Copy code" } as const;

test("raw HTML from the model is escaped, never parsed", () => {
  const html = renderMarkdown('Hi <img src=x onerror="alert(1)"> and <b>bold</b>', options);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).toContain("&lt;img");
  expect(html).toContain("onerror");
});

test("a script block is escaped rather than emitted", () => {
  const html = renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter", options);
  expect(html).not.toContain("<script");
  expect(html).toContain("&lt;script&gt;");
});

test("javascript: and data:text/html links are stripped to their text", () => {
  const js = renderMarkdown("[click](javascript:alert(1))", options);
  expect(js).not.toContain("javascript:");
  expect(js).toContain("click");

  // A control character inside the scheme must not defeat the prefix check.
  const obfuscated = renderMarkdown("[click](java\u0009script:alert(1))", options);
  expect(obfuscated.toLowerCase()).not.toContain("javascript:");

  const dataHtml = renderMarkdown("![x](data:text/html;base64,PHNjcmlwdD4=)", options);
  expect(dataHtml).not.toContain("data:text/html");
});

test("safe links open externally with noopener", () => {
  const html = renderMarkdown("[docs](https://example.test/a?b=1)", options);
  expect(html).toContain('href="https://example.test/a?b=1"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("noopener");
});

test("data: image URLs are allowed so attachment echoes render", () => {
  const html = renderMarkdown("![shot](data:image/png;base64,iVBORw0KGgo=)", options);
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(html).toContain("chat-md-image");
});

test("code fences render a header with a language label and a copy button", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```", options);
  expect(html).toContain("chat-code");
  expect(html).toContain(">ts<");
  expect(html).toContain("data-chat-copy");
  expect(html).toContain('aria-label="Copy code"');
  // Without a ready highlighter the body is a plain escaped pre.
  expect(html).toContain("chat-code-plain");
  expect(html).toContain("const a = 1;");
});

test("code content is escaped inside the plain fallback", () => {
  const html = renderMarkdown("```\n<script>x</script>\n```", options);
  expect(html).not.toContain("<script>x");
  expect(html).toContain("&lt;script&gt;");
});

test("collectCodeLanguages resolves aliases and ignores unknown labels", () => {
  const langs = collectCodeLanguages([
    "```ts",
    "a",
    "```",
    "",
    "```py",
    "b",
    "```",
    "",
    "```not-a-language",
    "c",
    "```",
  ].join("\n"));
  expect(langs.sort()).toEqual(["python", "typescript"]);
});

test("resolveLang maps common aliases and rejects unsupported ones", () => {
  expect(resolveLang("sh")).toBe("bash");
  expect(resolveLang("JS")).toBe("javascript");
  expect(resolveLang("c++")).toBe("cpp");
  expect(resolveLang("yml")).toBe("yaml");
  expect(resolveLang("ts title=x")).toBe("typescript");
  expect(resolveLang("brainfuck")).toBeNull();
  expect(resolveLang(undefined)).toBeNull();
});

test("escapeHtml covers every delimiter that could break out of an attribute", () => {
  expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
});

test("tables and lists render as GFM", () => {
  const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two", options);
  expect(html).toContain("<table>");
  expect(html).toContain("<ul>");
});

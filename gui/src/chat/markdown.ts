/**
 * Markdown → HTML for chat messages.
 *
 * Security posture: raw HTML in model output is ESCAPED, never passed through.
 * The rendered string goes into `dangerouslySetInnerHTML`, so anything a model
 * emits would otherwise execute in the dashboard origin — which holds the
 * management session. Escaping instead of sanitizing keeps the guarantee simple
 * (no allowlist to get wrong, no sanitizer dependency to keep patched) and costs
 * only the rare case where a model deliberately writes HTML for display, which
 * then shows as source. `href`/`src` are additionally scheme-checked so a
 * markdown-syntax `[x](javascript:…)` link cannot slip past the escape.
 *
 * Code blocks get a header row (language label + copy button) and Shiki markup.
 * Copy is delegated from the message container, so the button carries no code
 * payload: the handler reads the adjacent `<pre>`'s text. That keeps the DOM
 * small and the copied text byte-identical to what is displayed.
 */
import { Marked, type Tokens } from "marked";
import type { HighlighterCore } from "shiki/core";
import { DARK_THEME, LIGHT_THEME, isLangReady, resolveLang } from "./highlight";

/** Attribute the copy handler looks for. */
export const COPY_BUTTON_ATTR = "data-chat-copy";
/** Attribute naming the copy target kind, for the button label. */
export const COPY_KIND_ATTR = "data-chat-copy-kind";

const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;
/** Images may also be inline data URLs — the user's own attachments echo back this way. */
const SAFE_IMAGE_SCHEME = /^(https?:|data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);|#|\/|\.\/|\.\.\/)/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(href: string, pattern: RegExp): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Control characters are stripped first: "java&#9;script:" defeats a naive
  // prefix test, and browsers ignore those bytes when resolving the scheme.
  // Filtered by code point rather than a character class, which would put
  // literal control characters in a regex (and in this file).
  let normalized = "";
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    normalized += character;
  }
  return pattern.test(normalized) ? normalized : null;
}

/** Every fence language in `markdown`, so the caller can preload those grammars. */
export function collectCodeLanguages(markdown: string): string[] {
  const langs = new Set<string>();
  // Fence openers only: an indented "```" inside a block is still an opener in
  // CommonMark, so the loose match is correct here (over-collecting a grammar is
  // harmless; missing one costs a highlight).
  for (const match of markdown.matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]+)/gm)) {
    const lang = resolveLang(match[1]);
    if (lang) langs.add(lang);
  }
  return [...langs];
}

/** Fence label shown in the code-block header, before grammar resolution. */
function displayLang(raw: string | undefined): string {
  const first = (raw ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length > 24 ? first.slice(0, 24) : first;
}

export interface RenderMarkdownOptions {
  /** Ready highlighter, or null to render plain code blocks. */
  highlighter?: HighlighterCore | null;
  /** Localized label for the copy button (`aria-label` / `title`). */
  copyLabel: string;
}

/**
 * One `Marked` instance per render, not a shared module singleton: the renderer
 * closes over the highlighter and the localized copy label, both of which change
 * at runtime (locale switch, highlighter arriving after first paint).
 */
export function renderMarkdown(markdown: string, options: RenderMarkdownOptions): string {
  const { highlighter, copyLabel } = options;
  const marked = new Marked({ gfm: true, breaks: true });
  const escapedCopyLabel = escapeHtml(copyLabel);

  marked.use({
    renderer: {
      // Raw HTML — block and inline — is shown as text, never parsed.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      code({ text, lang }: Tokens.Code) {
        const label = displayLang(lang);
        const resolved = resolveLang(lang);
        let body: string | null = null;
        if (highlighter && resolved && isLangReady(highlighter, resolved)) {
          try {
            body = highlighter.codeToHtml(text, {
              lang: resolved,
              themes: { light: LIGHT_THEME, dark: DARK_THEME },
              // Emit CSS variables for both themes so the dashboard's theme
              // switch is pure CSS and never re-highlights.
              defaultColor: false,
            });
          } catch {
            body = null;
          }
        }
        if (body === null) {
          body = `<pre class="chat-code-plain"><code>${escapeHtml(text)}</code></pre>`;
        }
        const head = `<div class="chat-code-head">`
          + `<span class="chat-code-lang">${escapeHtml(label)}</span>`
          + `<button type="button" class="chat-code-copy" ${COPY_BUTTON_ATTR} ${COPY_KIND_ATTR}="code"`
          + ` aria-label="${escapedCopyLabel}" title="${escapedCopyLabel}">`
          + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`
          + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
          + `<rect x="9" y="9" width="11" height="11" rx="2"/>`
          + `<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>`
          + `</button></div>`;
        return `<div class="chat-code">${head}<div class="chat-code-body">${body}</div></div>`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const safe = safeUrl(href, SAFE_URL_SCHEME);
        const inner = this.parser.parseInline(tokens);
        if (!safe) return inner;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // Model-authored links are external by default; noopener/noreferrer keeps
        // the dashboard window unreachable from the opened page.
        return `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const safe = safeUrl(href, SAFE_IMAGE_SCHEME);
        if (!safe) return escapeHtml(text);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" class="chat-md-image" />`;
      },
    },
  });

  try {
    return marked.parse(markdown, { async: false });
  } catch {
    // A malformed document must still render as readable text.
    return `<p>${escapeHtml(markdown)}</p>`;
  }
}

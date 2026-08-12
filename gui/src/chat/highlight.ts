/**
 * Syntax highlighting for chat code blocks.
 *
 * Shiki's fine-grained bundle, not `shiki` proper: the full bundle pulls every
 * grammar and theme into the entry chunk (megabytes), which the dashboard would
 * pay for on every page load whether or not the user opens Chat. Here the core
 * plus one theme pair loads on first highlight, and each language arrives as its
 * own dynamic chunk the first time a block claims it.
 *
 * The JavaScript regex engine (not Oniguruma/WASM) keeps the transport to plain
 * JS modules — no `.wasm` asset to serve or MIME-type, which matters because the
 * dashboard is served by the proxy itself. `forgiving: true` degrades an
 * unsupported grammar pattern to no-match instead of throwing mid-render.
 *
 * Both themes render at once via CSS variables (`defaultColor: false`), so a
 * theme switch is a CSS concern and highlighting is never re-run for it.
 */
import type { HighlighterCore } from "shiki/core";

export const LIGHT_THEME = "github-light-default";
export const DARK_THEME = "github-dark-default";

/**
 * Grammar loaders keyed by the id we ask Shiki for. Aliases are resolved to
 * these ids by `resolveLang` before any loading happens, so one grammar is
 * never fetched twice under two names.
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

/** Fence labels people actually type, mapped onto the loader ids above. */
const LANG_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  gql: "graphql",
  htm: "html",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsonc: "json",
  json5: "json",
  kt: "kotlin",
  md: "markdown",
  mdown: "markdown",
  patch: "diff",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  console: "bash",
  zsh: "bash",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  yml: "yaml",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
  svg: "xml",
};

/** The Shiki grammar id for a fence label, or null when we have no grammar. */
export function resolveLang(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().split(/[\s,{]/)[0] ?? "";
  if (!key) return null;
  const resolved = LANG_ALIASES[key] ?? key;
  return LANG_LOADERS[resolved] ? resolved : null;
}

let highlighterPromise: Promise<HighlighterCore | null> | null = null;
const loadedLangs = new Set<string>();
const langLoads = new Map<string, Promise<void>>();

function createHighlighter(): Promise<HighlighterCore | null> {
  return (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      return await createHighlighterCore({
        themes: [
          import("shiki/themes/github-light-default.mjs"),
          import("shiki/themes/github-dark-default.mjs"),
        ],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    } catch {
      // Highlighting is decoration. A failed chunk load must leave plain,
      // readable code blocks rather than an empty message body.
      return null;
    }
  })();
}

/** The lazily created shared highlighter, or null when Shiki could not load. */
export function getHighlighter(): Promise<HighlighterCore | null> {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

/**
 * Load the grammars for `langs`, resolving once every one is either registered
 * or known-unavailable. Callers can then highlight synchronously, which is what
 * lets the markdown renderer stay a single pass.
 */
export async function ensureLangs(langs: Iterable<string>): Promise<void> {
  const highlighter = await getHighlighter();
  if (!highlighter) return;
  const pending: Promise<void>[] = [];
  for (const raw of langs) {
    const lang = resolveLang(raw);
    if (!lang || loadedLangs.has(lang)) continue;
    let load = langLoads.get(lang);
    if (!load) {
      load = (async () => {
        try {
          const module = await LANG_LOADERS[lang]!();
          await highlighter.loadLanguage(module as never);
          loadedLangs.add(lang);
        } catch {
          // Mark it loaded anyway: a grammar that failed once will fail again,
          // and retrying per code block would stall every later render.
          loadedLangs.add(lang);
        }
      })();
      langLoads.set(lang, load);
    }
    pending.push(load);
  }
  if (pending.length > 0) await Promise.all(pending);
}

/** True when `lang`'s grammar is registered and safe to highlight synchronously. */
export function isLangReady(highlighter: HighlighterCore, lang: string): boolean {
  return highlighter.getLoadedLanguages().includes(lang);
}

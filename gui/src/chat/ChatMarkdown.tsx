/**
 * Rendered markdown for one chat message.
 *
 * Two-pass by necessity: the first render escapes and structures the markdown
 * with whatever grammars are already registered, then an effect loads the
 * grammars this message actually needs and re-renders once they arrive. A
 * streaming message re-renders on every delta anyway, so the extra pass is only
 * visible on the first block of a new language — it appears unhighlighted for a
 * frame and then colorizes.
 *
 * Copy is one delegated listener on the container rather than a React node per
 * block: the code blocks are raw HTML from the renderer, so there is nothing to
 * attach a React handler to, and delegation keeps the copied bytes exactly what
 * the `<pre>` displays.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { getHighlighter, ensureLangs } from "./highlight";
import { COPY_BUTTON_ATTR, collectCodeLanguages, renderMarkdown } from "./markdown";
import type { HighlighterCore } from "shiki/core";

const COPIED_FEEDBACK_MS = 1600;

export default function ChatMarkdown({ text }: { text: string }) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
  /** Bumped when new grammars register, to force a re-render with highlighting. */
  const [langEpoch, setLangEpoch] = useState(0);

  const langs = useMemo(() => collectCodeLanguages(text), [text]);
  const langKey = langs.join(",");

  useEffect(() => {
    if (langKey.length === 0) return;
    let cancelled = false;
    void (async () => {
      const instance = await getHighlighter();
      if (cancelled || !instance) return;
      await ensureLangs(langKey.split(","));
      if (cancelled) return;
      setHighlighter(instance);
      setLangEpoch(epoch => epoch + 1);
    })();
    return () => { cancelled = true; };
  }, [langKey]);

  const html = useMemo(
    () => renderMarkdown(text, { highlighter, copyLabel: t("chat.copyCode") }),
    // langEpoch is a render trigger, not an input: a new grammar changes what
    // `renderMarkdown` can highlight without changing any of its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, highlighter, langEpoch, t],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest(`[${COPY_BUTTON_ATTR}]`) as HTMLElement | null;
      if (!button || !container.contains(button)) return;
      event.preventDefault();
      const block = button.closest(".chat-code")?.querySelector("pre");
      const code = block?.textContent ?? "";
      if (!code) return;
      void navigator.clipboard?.writeText(code).then(
        () => {
          button.classList.add("is-copied");
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            button.classList.remove("is-copied");
            timer = null;
          }, COPIED_FEEDBACK_MS);
        },
        () => {
          button.classList.add("is-copy-failed");
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            button.classList.remove("is-copy-failed");
            timer = null;
          }, COPIED_FEEDBACK_MS);
        },
      );
    };
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("click", onClick);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="chat-markdown"
      // Safe by construction: `renderMarkdown` escapes all model-authored HTML
      // and scheme-checks every href/src. See gui/src/chat/markdown.ts.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

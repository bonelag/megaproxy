/**
 * Thinking-effort selector: a pill in the composer toolbar that opens a drop-up.
 *
 * It drops UP because it lives at the bottom of the viewport inside the composer
 * card; a downward menu would open off screen. Rendered inline (not portalled) so
 * the anchor and the menu share a positioned wrapper and cannot drift apart when
 * the composer grows with a long prompt.
 *
 * The rungs come from `effort.ts`, which owns the wire values. This component
 * only picks one.
 */
import { useEffect, useRef, useState } from "react";
import { IconBan, IconBolt, IconBrain, IconBrainCog, IconCheck, IconChevron, IconSparkles, IconStar } from "../icons";
import { useT } from "../i18n/shared";
import { CHAT_EFFORT_META, chatEffortMeta, type ChatEffort, type ChatEffortIcon } from "./effort";

const EFFORT_ICONS: Record<ChatEffortIcon, (props: { "aria-hidden"?: boolean }) => React.ReactElement> = {
  ban: IconBan,
  bolt: IconBolt,
  brainCog: IconBrainCog,
  brain: IconBrain,
  sparkles: IconSparkles,
  star: IconStar,
};

export function ChatEffortIconFor({ icon }: { icon: ChatEffortIcon }) {
  const Component = EFFORT_ICONS[icon];
  return <Component aria-hidden />;
}

export default function ChatEffortPicker({
  effort,
  disabled,
  onChange,
}: {
  effort: ChatEffort;
  disabled: boolean;
  onChange: (next: ChatEffort) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = chatEffortMeta(effort);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="chat-effort" ref={wrapRef}>
      <button
        type="button"
        className={`chat-tool-pill${open ? " is-open" : ""}`}
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("chat.effortLabel")}
        title={t("chat.effortLabel")}
      >
        <ChatEffortIconFor icon={current.icon} />
        <span>{t(current.tkey)}</span>
        <IconChevron aria-hidden className="chat-pill-caret" />
      </button>

      {open && (
        <div className="chat-menu chat-menu--up chat-effort-menu" role="menu">
          <p className="chat-menu-head">{t("chat.effortLabel")}</p>
          {CHAT_EFFORT_META.map(meta => (
            <button
              key={meta.id}
              type="button"
              role="menuitemradio"
              aria-checked={meta.id === effort}
              className={`chat-menu-row${meta.id === effort ? " is-active" : ""}`}
              onClick={() => { onChange(meta.id); setOpen(false); }}
            >
              <ChatEffortIconFor icon={meta.icon} />
              <span className="chat-menu-label">{t(meta.tkey)}</span>
              {meta.id === effort && <IconCheck aria-hidden className="chat-menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

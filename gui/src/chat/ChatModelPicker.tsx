/**
 * Model picker: a two-line pill in the header that opens a searchable panel.
 *
 * Grouped by provider with a per-group count, because "which models do I have"
 * is really "what did each provider give me" — a flat list of 200 rows from six
 * gateways is unreadable. Search covers the label, the routing slug, and the
 * provider name, so users can type either half of `agr/claude-opus-5`.
 *
 * The panel is rendered inline under the pill, not portalled: it is anchored to
 * the pill and the page has no competing scroll container above it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevron, IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { filterChatModels, groupChatModels, type ChatModelOption } from "./models";

export default function ChatModelPicker({
  options,
  selected,
  disabled,
  onSelect,
}: {
  options: ChatModelOption[];
  selected: ChatModelOption | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(
    () => groupChatModels(filterChatModels(options, query)),
    [options, query],
  );

  return (
    <div className="chat-model-picker" ref={wrapRef}>
      <button
        type="button"
        className={`chat-model-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("chat.model")}
      >
        <span className="chat-model-trigger-main">
          <span className="chat-model-trigger-name">{selected?.label ?? t("chat.noModelSelected")}</span>
          <IconChevron aria-hidden className="chat-pill-caret" />
        </span>
        {selected && <span className="chat-model-trigger-slug">{selected.slug}</span>}
      </button>

      {open && (
        <div className="chat-menu chat-model-panel" role="dialog" aria-label={t("chat.modelsPanelTitle")}>
          <div className="chat-model-panel-head">
            <p className="chat-menu-head">{t("chat.modelsPanelTitle")}</p>
            <p className="chat-model-panel-sub">{t("chat.modelsPanelSub")}</p>
          </div>

          <div className="chat-model-search">
            <IconSearch aria-hidden />
            <input
              ref={searchRef}
              type="search"
              className="chat-model-search-input"
              value={query}
              placeholder={t("chat.modelSearchPlaceholder")}
              onChange={event => setQuery(event.target.value)}
              aria-label={t("chat.modelSearchPlaceholder")}
            />
          </div>

          <div className="chat-model-groups">
            {groups.length === 0
              ? <p className="chat-model-none">{t("chat.modelSearchEmpty")}</p>
              : groups.map(group => (
                <section key={group.providerId} className="chat-model-group">
                  <header className="chat-model-group-head">
                    <span className="chat-model-group-name">{group.provider}</span>
                    <span className="chat-model-group-count">{group.models.length}</span>
                  </header>
                  <div className="chat-model-grid">
                    {group.models.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        className={`chat-model-card${option.id === selected?.id ? " is-active" : ""}`}
                        onClick={() => { onSelect(option.id); setOpen(false); }}
                        aria-current={option.id === selected?.id ? "true" : undefined}
                      >
                        <span className="chat-model-card-name">{option.label}</span>
                        <span className="chat-model-card-slug">{option.slug}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

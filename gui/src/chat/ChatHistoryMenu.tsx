/**
 * Chat history, as a popover anchored to the header's History pill.
 *
 * This replaced a persistent rail: at this width the transcript is the page, and
 * a permanent 264px column of thread titles is a column the user reads once.
 * Rows come from the summaries store, so this never deserializes a message body.
 *
 * Rename is inline rather than a modal — the title is one line of text and a
 * dialog for it would be three clicks for a typo fix.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconHistory, IconTrash, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { relativeAge } from "./relative-age";
import type { ChatConversationSummary } from "./types";

export default function ChatHistoryMenu({
  summaries,
  activeId,
  locale,
  disabled,
  onSelect,
  onDelete,
  onRename,
  onClearAll,
}: {
  summaries: ChatConversationSummary[];
  activeId: string | null;
  locale: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onClearAll: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Closing discards the popover's transient state: a half-finished rename or an
   * armed clear-all must not be waiting behind it on the next open. Every close
   * path routes through here rather than an effect on `open`, which would be a
   * cascading setState (react-hooks/set-state-in-effect).
   */
  const close = useCallback(() => {
    setOpen(false);
    setRenamingId(null);
    setConfirmClear(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const commitRename = () => {
    if (renamingId && draft.trim()) onRename(renamingId, draft);
    setRenamingId(null);
  };

  return (
    <div className="chat-history" ref={wrapRef}>
      <button
        type="button"
        className={`chat-header-pill${open ? " is-open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconHistory aria-hidden />
        <span>{t("chat.history")}</span>
      </button>

      {open && (
        <div className="chat-menu chat-history-panel" role="dialog" aria-label={t("chat.historyLabel")}>
          <p className="chat-menu-head">{t("chat.recentChats")}</p>

          {summaries.length === 0
            ? <p className="chat-history-empty">{t("chat.noHistory")}</p>
            : (
              <ul className="chat-history-list">
                {summaries.map(row => (
                  <li key={row.id}>
                    {renamingId === row.id
                      ? (
                        <div className="chat-history-rename">
                          <input
                            ref={renameInputRef}
                            className="input"
                            value={draft}
                            onChange={event => setDraft(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === "Enter") commitRename();
                              if (event.key === "Escape") setRenamingId(null);
                            }}
                            aria-label={t("chat.renameLabel")}
                          />
                          <button
                            type="button"
                            className="chat-history-action"
                            onClick={commitRename}
                            aria-label={t("chat.renameSave")}
                            title={t("chat.renameSave")}
                          >
                            <IconCheck aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="chat-history-action"
                            onClick={() => setRenamingId(null)}
                            aria-label={t("chat.renameCancel")}
                            title={t("chat.renameCancel")}
                          >
                            <IconX aria-hidden />
                          </button>
                        </div>
                      )
                      : (
                        <div className={`chat-history-row${row.id === activeId ? " is-active" : ""}`}>
                          <button
                            type="button"
                            className="chat-history-select"
                            onClick={() => { onSelect(row.id); close(); }}
                            disabled={disabled}
                            aria-current={row.id === activeId ? "true" : undefined}
                            onDoubleClick={() => { setRenamingId(row.id); setDraft(row.title); }}
                          >
                            <span className="chat-history-title">{row.title}</span>
                            <span className="chat-history-preview">{row.preview || t("chat.emptyChat")}</span>
                          </button>
                          <span className="chat-history-age">{relativeAge(row.updatedAt, locale)}</span>
                          <button
                            type="button"
                            className="chat-history-action chat-history-delete"
                            onClick={() => onDelete(row.id)}
                            aria-label={t("chat.deleteChat")}
                            title={t("chat.deleteChat")}
                          >
                            <IconTrash aria-hidden />
                          </button>
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            )}

          {summaries.length > 0 && (
            <div className="chat-history-foot">
              {confirmClear
                ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => { onClearAll(); close(); }}
                    >
                      {t("chat.clearAllConfirm")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(false)}>
                      {t("chat.renameCancel")}
                    </button>
                  </>
                )
                : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(true)}>
                    <IconTrash aria-hidden /> {t("chat.clearAll")}
                  </button>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

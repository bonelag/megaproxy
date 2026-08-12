/**
 * One message: role, thinking, body, attachments, and per-message actions.
 *
 * The assistant body renders through `ChatMarkdown`; the user body stays plain
 * text. That asymmetry is deliberate — a user who types `# note` means a hash,
 * and rendering their own input as markdown makes the composer feel lossy.
 *
 * Thinking gets its own panel above the answer. It opens itself while the model
 * is still thinking (there is nothing else to look at yet) and closes as soon as
 * the answer starts arriving, unless the user has taken over the disclosure — an
 * explicit toggle always wins, in both directions, for the life of the message.
 */
import { useState } from "react";
import { IconAlert, IconCheck, IconChevron, IconRefresh, IconTrash } from "../icons";
import { useI18n } from "../i18n/shared";
import { formatBytes } from "../format-bytes";
import ChatMarkdown from "./ChatMarkdown";
import { ChatEffortIconFor } from "./ChatEffortPicker";
import { chatEffortMeta } from "./effort";
import type { ChatMessage } from "./types";

const COPIED_FEEDBACK_MS = 1600;

export default function ChatMessageView({
  message,
  streaming,
  canRegenerate,
  onRegenerate,
  onTruncate,
}: {
  message: ChatMessage;
  /** True when this is the assistant turn currently receiving deltas. */
  streaming: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onTruncate: () => void;
}) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  /** null until the user touches the disclosure; then it pins the state. */
  const [reasoningPick, setReasoningPick] = useState<boolean | null>(null);
  const isUser = message.role === "user";
  const thinkingNow = streaming && !message.content;
  const reasoningOpen = reasoningPick ?? thinkingNow;
  const effort = message.effort ? chatEffortMeta(message.effort) : null;

  const copyMessage = () => {
    void navigator.clipboard?.writeText(message.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      },
      () => { /* clipboard denied — no false success */ },
    );
  };

  return (
    <article className={`chat-msg chat-msg--${isUser ? "user" : "assistant"}`}>
      <div className="chat-msg-head">
        <span className="chat-msg-role">
          {isUser ? t("chat.roleYou") : (message.model || t("chat.roleAssistant"))}
        </span>
        {!isUser && effort && (
          <span className="chat-msg-effort" title={t("chat.effortLabel")}>
            <ChatEffortIconFor icon={effort.icon} />
            {t(effort.tkey)}
          </span>
        )}
        {message.stopped && <span className="chat-msg-flag">{t("chat.stoppedFlag")}</span>}
        {typeof message.durationMs === "number" && !streaming && (
          <span className="chat-msg-duration">{(message.durationMs / 1000).toFixed(1)}s</span>
        )}
        <div className="chat-msg-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={copyMessage}
            aria-label={t("chat.copyMessage")}
            title={t("chat.copyMessage")}
            disabled={!message.content}
          >
            {copied ? <IconCheck aria-hidden /> : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h8" />
              </svg>
            )}
          </button>
          {!isUser && canRegenerate && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={onRegenerate}
              aria-label={t("chat.regenerate")}
              title={t("chat.regenerate")}
            >
              <IconRefresh aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onTruncate}
            aria-label={t("chat.deleteFromHere")}
            title={t("chat.deleteFromHere")}
          >
            <IconTrash aria-hidden />
          </button>
        </div>
      </div>

      {message.attachments && message.attachments.length > 0 && (
        <ul className="chat-attach-list">
          {message.attachments.map(attachment => (
            <li key={attachment.id} className="chat-attach">
              {attachment.kind === "image" && attachment.dataUrl
                ? <img src={attachment.dataUrl} alt={attachment.name} className="chat-attach-thumb" />
                : <span className="chat-attach-file" aria-hidden>TXT</span>}
              <span className="chat-attach-name" title={attachment.name}>{attachment.name}</span>
              <span className="chat-attach-size">{formatBytes(attachment.size, locale)}</span>
            </li>
          ))}
        </ul>
      )}

      {message.reasoning && (
        <div className={`chat-reasoning${reasoningOpen ? " is-open" : ""}${thinkingNow ? " is-live" : ""}`}>
          <button
            type="button"
            className="chat-reasoning-toggle"
            onClick={() => setReasoningPick(!reasoningOpen)}
            aria-expanded={reasoningOpen}
          >
            <span className="chat-reasoning-glyph" aria-hidden>
              {thinkingNow
                ? <span className="chat-reasoning-pulse" />
                : <ChatEffortIconFor icon={effort?.icon ?? "bolt"} />}
            </span>
            <span className="chat-reasoning-label">
              {thinkingNow ? t("chat.thinkingNow") : t("chat.thoughtProcess")}
            </span>
            <IconChevron aria-hidden className={reasoningOpen ? "is-open" : ""} />
          </button>
          {reasoningOpen && (
            <div className="chat-reasoning-body">
              {/* Same renderer as the answer: model-authored HTML stays escaped
                  and URL schemes checked. A plain <pre> here would be safe too,
                  but reasoning is written in markdown and reads as soup. */}
              <ChatMarkdown text={message.reasoning} />
            </div>
          )}
        </div>
      )}

      <div className="chat-msg-body">
        {isUser
          ? <p className="chat-msg-text">{message.content}</p>
          : message.content
            ? <ChatMarkdown text={message.content} />
            : streaming && !message.reasoning
              ? <span className="chat-typing" aria-label={t("chat.thinking")}><i /><i /><i /></span>
              : null}
        {streaming && message.content && <span className="chat-caret" aria-hidden />}
      </div>

      {message.error && (
        <p className="chat-msg-error" role="alert">
          <IconAlert aria-hidden /> {message.error}
        </p>
      )}
    </article>
  );
}

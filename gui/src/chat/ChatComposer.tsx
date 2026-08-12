/**
 * The composer card: prompt textarea with its toolbar inside the same surface.
 *
 * Layout matches the reference: the textarea sits on top, and one row below it
 * carries attach, the Chat/Image mode switch, the thinking-effort pill, the
 * active model, and a circular send button. The send button is icon-only, so it
 * is reachable by `aria-label` rather than text.
 *
 * Enter sends, Shift+Enter newlines — the convention every chat client uses, and
 * the one users will try first. The textarea auto-grows to a cap so a long paste
 * stays scrollable instead of pushing the transcript off screen.
 *
 * Attachments arrive three ways (picker, paste, drop) and all three funnel into
 * the same `readAttachments`, so the size/type rules cannot diverge per entry
 * point.
 */
import { useCallback, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { IconArrowUp, IconImage, IconMessage, IconPaperclip, IconPause, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { formatBytes } from "../format-bytes";
import ChatEffortPicker from "./ChatEffortPicker";
import {
  MAX_ATTACHMENTS,
  filesFromClipboard,
  readAttachments,
  type AttachmentError,
} from "./attachments";
import type { ChatEffort } from "./effort";
import type { ChatAttachment } from "./types";

const MAX_TEXTAREA_PX = 260;

export default function ChatComposer({
  disabled,
  streaming,
  supportsImages,
  modelLabel,
  effort,
  onEffortChange,
  onSend,
  onStop,
}: {
  disabled: boolean;
  streaming: boolean;
  /** Whether the selected model advertises image input — drives the hint only. */
  supportsImages: boolean;
  /** Shown as plain text in the toolbar so the active model is always visible. */
  modelLabel: string;
  effort: ChatEffort;
  onEffortChange: (next: ChatEffort) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
}) {
  const { t, locale } = useI18n();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachErrors, setAttachErrors] = useState<AttachmentError[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, []);

  const intake = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const result = await readAttachments(files, attachments.length);
    if (result.attachments.length > 0) {
      setAttachments(previous => [...previous, ...result.attachments]);
    }
    setAttachErrors(result.errors);
  }, [attachments.length]);

  const empty = !text.trim() && attachments.length === 0;

  const submit = () => {
    if (disabled || streaming || empty) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
    setAttachErrors([]);
    // Drop the grown inline height so the cleared textarea collapses back to one
    // row. `auto` needs no measurement, so it is correct before React commits the
    // empty value — unlike `resize()`, which would read the pre-clear scrollHeight.
    const element = textareaRef.current;
    if (element) element.style.height = "auto";
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition must not be committed as a send: `isComposing` is true
    // while a CJK candidate is open, where Enter selects a candidate.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void intake([...(event.target.files ?? [])]);
    // Clearing the input lets the same file be picked twice in a row.
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void intake([...(event.dataTransfer?.files ?? [])]);
  };

  const errorText = (error: AttachmentError): string => {
    switch (error.reason) {
      case "unsupported": return t("chat.attachUnsupported", { name: error.name });
      case "too-large": return t("chat.attachTooLarge", { name: error.name, limit: formatBytes(error.limit, locale) });
      case "too-many": return t("chat.attachTooMany", { limit: String(error.limit) });
      case "read-failed": return t("chat.attachReadFailed", { name: error.name });
    }
  };

  return (
    <div
      className={`chat-composer${dragging ? " is-dragging" : ""}`}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <ul className="chat-composer-tray">
          {attachments.map(attachment => (
            <li key={attachment.id} className="chat-tray-item">
              {attachment.kind === "image" && attachment.dataUrl
                ? <img src={attachment.dataUrl} alt="" className="chat-tray-thumb" />
                : <span className="chat-tray-file" aria-hidden>TXT</span>}
              <span className="chat-tray-name" title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                className="chat-tray-remove"
                onClick={() => setAttachments(previous => previous.filter(item => item.id !== attachment.id))}
                aria-label={t("chat.removeAttachment", { name: attachment.name })}
                title={t("chat.removeAttachment", { name: attachment.name })}
              >
                <IconX aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {attachErrors.length > 0 && (
        <ul className="chat-composer-errors" role="alert">
          {attachErrors.map((error, index) => <li key={index}>{errorText(error)}</li>)}
        </ul>
      )}

      <textarea
        ref={textareaRef}
        className="chat-input"
        value={text}
        rows={1}
        placeholder={disabled ? t("chat.noModelPlaceholder") : t("chat.placeholder")}
        disabled={disabled}
        onChange={event => { setText(event.target.value); resize(); }}
        onKeyDown={onKeyDown}
        onPaste={event => {
          const files = filesFromClipboard(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          void intake(files);
        }}
        aria-label={t("chat.inputLabel")}
      />

      <div className="chat-composer-tools">
        <button
          type="button"
          className="chat-tool-icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
          aria-label={t("chat.attach")}
          title={supportsImages ? t("chat.attach") : t("chat.attachTextOnlyHint")}
        >
          <IconPaperclip aria-hidden />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={onPickFiles}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Mode switch. Image generation is out of scope for this tab, so the
            Image segment is present for parity but permanently inert — a live
            control that produced nothing would be worse than a disabled one. */}
        <div className="chat-mode-switch" role="group" aria-label={t("chat.modeLabel")}>
          <button type="button" className="chat-mode-seg is-active" aria-pressed="true">
            <IconMessage aria-hidden />
            <span>{t("chat.modeChat")}</span>
          </button>
          <button
            type="button"
            className="chat-mode-seg"
            aria-pressed="false"
            disabled
            title={t("chat.modeImageSoon")}
          >
            <IconImage aria-hidden />
            <span>{t("chat.modeImage")}</span>
          </button>
        </div>

        <ChatEffortPicker effort={effort} disabled={disabled} onChange={onEffortChange} />

        {modelLabel && <span className="chat-tool-model" title={modelLabel}>{modelLabel}</span>}

        {streaming
          ? (
            <button
              type="button"
              className="chat-send"
              onClick={onStop}
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
            >
              <IconPause aria-hidden />
            </button>
          )
          : (
            <button
              type="button"
              className="chat-send"
              onClick={submit}
              disabled={disabled || empty}
              aria-label={t("chat.send")}
              title={t("chat.sendHint")}
            >
              <IconArrowUp aria-hidden />
            </button>
          )}
      </div>
    </div>
  );
}

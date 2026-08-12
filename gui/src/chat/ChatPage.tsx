/**
 * Chat page — talk to any model this proxy exposes, from the dashboard.
 *
 * Auth: this surface deliberately requires NO data-plane API key. It posts to
 * `/api/chat/completions`, the management-plane relay, which is authorized by
 * the dashboard credential the GUI already holds. Whatever `apiKeys` the proxy
 * has configured is irrelevant here — see src/server/management/chat-routes.ts
 * for why that is not a widening of access.
 *
 * Layout is a single column: a thin header (model pill left, history + new chat
 * right), the transcript, and an inset composer card. There is no conversation
 * rail — history moved into the header popover so the transcript owns the width.
 *
 * The model picker sits in the header because the model is per-turn, not
 * per-thread: switching it mid-conversation is a supported move (and the reason
 * assistant messages carry their own `model` and `effort`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { Notice } from "../ui";
import { IconMessage, IconPlus, IconRefresh, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import ChatComposer from "./ChatComposer";
import ChatHistoryMenu from "./ChatHistoryMenu";
import ChatMessageView from "./ChatMessageView";
import ChatModelPicker from "./ChatModelPicker";
import { DEFAULT_CHAT_EFFORT, sanitizeChatEffort, type ChatEffort } from "./effort";
import { toChatModelOptions, type ChatModelOption } from "./models";
import { useChatConversations } from "./use-chat-conversations";
import type { ChatAttachment } from "./types";

export default function Chat({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  /**
   * The user's explicit pick, which may be empty (nothing picked yet) or stale
   * (a model that has since disappeared). The model actually in effect is
   * derived below rather than mirrored into state by an effect — a resolution
   * effect here would re-render on every model-list poll.
   */
  const [modelPick, setModelPick] = useState("");
  /** Same shape for effort: null means "not chosen in this session yet". */
  const [effortPick, setEffortPick] = useState<ChatEffort | null>(null);
  const [systemDraft, setSystemDraft] = useState("");
  const [systemOpen, setSystemOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  /** False once the user scrolls up, so a stream never yanks them back down. */
  const pinnedToBottomRef = useRef(true);

  const loadModels = useCallback(async (signal: AbortSignal): Promise<ChatModelOption[]> => {
    const response = await fetch(`${apiBase}/api/models`, { signal });
    const rows = await readJsonOrThrow<unknown>(response, t("chat.modelsLoadFailed"));
    return toChatModelOptions(rows, t);
  }, [apiBase, t]);

  const models = useDataSurface<ChatModelOption[]>(
    `ocx.chat.models:${apiBase}`,
    [apiBase],
    loadModels,
    { isEmpty: rows => rows.length === 0 },
  );
  const modelOptions = useMemo(() => models.state.data ?? [], [models.state.data]);

  const conversations = useChatConversations({
    apiBase,
    untitledLabel: t("chat.untitled"),
  });
  const { active, streaming } = conversations;

  // Resolution order: an explicit pick, the active thread's model, the
  // remembered model, then the first available row. Falling through keeps a
  // reload on a saved thread on the model that thread was using, and a pick
  // that no longer exists degrades instead of sending an unroutable slug.
  const model = useMemo(() => {
    if (modelOptions.length === 0) return "";
    const available = new Set(modelOptions.map(option => option.id));
    return [modelPick, active?.model, conversations.lastModel]
      .find(candidate => candidate && available.has(candidate))
      ?? modelOptions[0]!.id;
  }, [active?.model, conversations.lastModel, modelPick, modelOptions]);

  // Same fall-through for the thinking rung: a reopened thread resumes the
  // effort it was using, and a fresh one inherits the last one chosen.
  const effort = useMemo<ChatEffort>(
    () => sanitizeChatEffort(effortPick ?? active?.effort ?? conversations.lastEffort ?? DEFAULT_CHAT_EFFORT),
    [active?.effort, conversations.lastEffort, effortPick],
  );

  /*
   * Form reset on thread switch, the same shape ProviderSettings uses: the
   * textarea is edit state, so it cannot be derived, and the saved value is the
   * one to show when the identity underneath it changes.
   */
  /* eslint-disable react-hooks/set-state-in-effect -- intentional form reset when the active thread changes */
  useEffect(() => {
    setSystemDraft(active?.systemPrompt ?? "");
  }, [active?.id, active?.systemPrompt]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const messages = useMemo(() => active?.messages ?? [], [active?.messages]);
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const streamingId = streaming ? lastMessageId : null;

  /**
   * Autoscroll only while the user is at the bottom. The check runs on every
   * transcript change (which during a stream is every flush), and reads the
   * scroll position rather than tracking wheel events — a keyboard scroll or a
   * scrollbar drag has to count too.
   */
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || !pinnedToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, streamingId]);

  const onTranscriptScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 48;
  };

  const selectedModel = useMemo(
    () => modelOptions.find(option => option.id === model) ?? null,
    [model, modelOptions],
  );

  const handleSend = (text: string, attachments: ChatAttachment[]) => {
    if (!model) return;
    pinnedToBottomRef.current = true;
    void conversations.send({
      text,
      attachments,
      model,
      effort,
      ...(systemDraft.trim() ? { systemPrompt: systemDraft.trim() } : {}),
    });
  };

  return (
    <div className="chat-page">
      {models.state.showError && (
        <Notice tone="err">
          {models.error instanceof Error ? models.error.message : t("chat.modelsLoadFailed")}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => models.refresh({ forceLoading: true })}>
            <IconRefresh aria-hidden /> {t("chat.retry")}
          </button>
        </Notice>
      )}

      {models.state.showSkeleton
        ? <DataSurfaceSkeleton label={t("chat.loadingModels")} rows={4} />
        : (
          <section className="chat-shell" aria-label={t("chat.threadLabel")}>
            <header className="chat-header">
              <ChatModelPicker
                options={modelOptions}
                selected={selectedModel}
                disabled={streaming || modelOptions.length === 0}
                onSelect={setModelPick}
              />
              <div className="chat-header-right">
                <button
                  type="button"
                  className={`chat-header-pill${systemOpen ? " is-open" : ""}`}
                  onClick={() => setSystemOpen(open => !open)}
                  aria-expanded={systemOpen}
                >
                  {t("chat.systemPrompt")}
                </button>
                <ChatHistoryMenu
                  summaries={conversations.summaries}
                  activeId={conversations.activeId}
                  locale={locale}
                  disabled={streaming}
                  onSelect={conversations.selectConversation}
                  onDelete={conversations.deleteConversation}
                  onRename={conversations.renameConversation}
                  onClearAll={conversations.clearAllConversations}
                />
                <button
                  type="button"
                  className="chat-header-plain"
                  onClick={() => conversations.startNewConversation(model)}
                  disabled={streaming}
                >
                  <IconPlus aria-hidden /> {t("chat.newChat")}
                </button>
              </div>
            </header>

            {systemOpen && (
              <div className="chat-system">
                <label className="field-label" htmlFor="chat-system-prompt">
                  {t("chat.systemPromptLabel")}
                </label>
                <textarea
                  id="chat-system-prompt"
                  className="input chat-system-input"
                  value={systemDraft}
                  rows={3}
                  placeholder={t("chat.systemPromptPlaceholder")}
                  onChange={event => setSystemDraft(event.target.value)}
                  onBlur={() => {
                    // Applies to the active thread immediately; a brand-new
                    // thread picks it up from the draft on first send.
                    if (active && (active.systemPrompt ?? "") !== systemDraft) {
                      conversations.setSystemPrompt(systemDraft);
                    }
                  }}
                />
              </div>
            )}

            <div
              className="chat-transcript"
              ref={transcriptRef}
              onScroll={onTranscriptScroll}
              aria-live="polite"
              aria-busy={streaming}
            >
              {messages.length === 0
                ? (
                  <div className="chat-welcome">
                    <span className="chat-welcome-tile" aria-hidden><IconMessage /></span>
                    <h2 className="chat-welcome-title">{t("chat.emptyTitle")}</h2>
                    <p className="chat-welcome-body">
                      {modelOptions.length === 0 ? t("chat.noModels") : t("chat.emptyBody")}
                    </p>
                  </div>
                )
                : messages.map(message => (
                  <ChatMessageView
                    key={message.id}
                    message={message}
                    streaming={message.id === streamingId}
                    canRegenerate={!streaming && message.id === lastMessageId}
                    onRegenerate={() => {
                      pinnedToBottomRef.current = true;
                      void conversations.regenerate(model, effort);
                    }}
                    onTruncate={() => conversations.truncateFrom(message.id)}
                  />
                ))}
            </div>

            {conversations.error && (
              <div className="chat-error-bar" role="alert">
                <span>{conversations.error}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={conversations.clearError}
                  aria-label={t("chat.dismissError")}
                  title={t("chat.dismissError")}
                >
                  <IconX aria-hidden />
                </button>
              </div>
            )}

            <div className="chat-composer-dock">
              <ChatComposer
                disabled={!model || modelOptions.length === 0}
                streaming={streaming}
                supportsImages={selectedModel?.supportsImages ?? false}
                modelLabel={selectedModel?.label ?? ""}
                effort={effort}
                onEffortChange={setEffortPick}
                onSend={handleSend}
                onStop={conversations.stop}
              />
              <p className="chat-dock-note">{t("chat.modelsFilteredNote")}</p>
            </div>
          </section>
        )}
    </div>
  );
}

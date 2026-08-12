/**
 * Chat conversation state: the store, the active thread, and the send loop.
 *
 * Extracted from the page so the component stays presentational-ish and so the
 * send loop can be reasoned about on its own. Two rules shape it:
 *
 *  1. The streaming assistant turn lives in React state and is written to
 *     IndexedDB only at settle. A per-delta write would be one IDB transaction
 *     per token.
 *  2. Persistence is fire-and-forget. A storage failure must not interrupt or
 *     roll back a turn the model already produced.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatStreamError, sendChatTurn } from "./client";
import { sanitizeChatEffort, type ChatEffort } from "./effort";
import { getChatStore } from "./storage";
import {
  deriveTitle,
  newId,
  summarizeConversation,
  type ChatAttachment,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatMessage,
} from "./types";

const LAST_CONVERSATION_KEY = "ocx-chat-last";
const LAST_MODEL_KEY = "ocx-chat-model";
const LAST_EFFORT_KEY = "ocx-chat-effort";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled — the rail still works, it just forgets the selection */
  }
}

export interface UseChatConversationsOptions {
  apiBase: string;
  /** Fallback title for a thread whose first turn has no text (image-only). */
  untitledLabel: string;
}

export interface SendTurnInput {
  text: string;
  attachments: ChatAttachment[];
  model: string;
  effort: ChatEffort;
  systemPrompt?: string;
}

export interface ChatConversationsApi {
  summaries: ChatConversationSummary[];
  active: ChatConversation | null;
  activeId: string | null;
  /** True until the first history read settles. */
  loading: boolean;
  /** True while a turn is streaming. */
  streaming: boolean;
  /** Non-null when the last turn failed; cleared on the next send. */
  error: string | null;
  /** Remembered model for a fresh thread. */
  lastModel: string | null;
  /** Remembered thinking effort for a fresh thread. */
  lastEffort: ChatEffort | null;
  selectConversation(id: string): void;
  startNewConversation(model: string): void;
  deleteConversation(id: string): void;
  renameConversation(id: string, title: string): void;
  clearAllConversations(): void;
  setSystemPrompt(prompt: string): void;
  send(input: SendTurnInput): Promise<void>;
  /** Re-run the last user turn, dropping the assistant turn it produced. */
  regenerate(model: string, effort: ChatEffort): Promise<void>;
  /** Drop this message and everything after it. */
  truncateFrom(messageId: string): void;
  stop(): void;
  clearError(): void;
}

export function useChatConversations(options: UseChatConversationsOptions): ChatConversationsApi {
  const { apiBase, untitledLabel } = options;
  const store = getChatStore();
  const [summaries, setSummaries] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(() => readLocal(LAST_MODEL_KEY));
  const [lastEffort, setLastEffort] = useState<ChatEffort | null>(() => {
    const stored = readLocal(LAST_EFFORT_KEY);
    return stored === null ? null : sanitizeChatEffort(stored);
  });
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Authoritative mirror of `active` for the send loop, which reads the
   * transcript at await points where a stale closure would replay an old
   * transcript to the model. Every write goes through `commitActive` /
   * `applyToActive` so the ref and the state can never disagree — nothing
   * assigns it during render.
   */
  const activeRef = useRef<ChatConversation | null>(null);

  const commitActive = useCallback((next: ChatConversation | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  /** Persist and refresh the rail row. Never awaited by a caller on the turn path. */
  const persist = useCallback((conversation: ChatConversation) => {
    setSummaries(previous => {
      const summary = summarizeConversation(conversation);
      const others = previous.filter(row => row.id !== conversation.id);
      return [summary, ...others].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    void store.put(conversation);
  }, [store]);

  const applyToActive = useCallback((
    id: string,
    update: (conversation: ChatConversation) => ChatConversation,
  ) => {
    const current = activeRef.current;
    if (!current || current.id !== id) return;
    commitActive(update(current));
  }, [commitActive]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await store.listSummaries();
      if (cancelled) return;
      setSummaries(rows);
      const remembered = readLocal(LAST_CONVERSATION_KEY);
      const target = remembered && rows.some(row => row.id === remembered)
        ? remembered
        : rows[0]?.id ?? null;
      if (target) {
        const conversation = await store.get(target);
        if (cancelled) return;
        commitActive(conversation);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [commitActive, store]);

  // Abort any in-flight turn when the page unmounts, so a navigation away does
  // not leave a stream writing into a dead component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const selectConversation = useCallback((id: string) => {
    if (abortRef.current) return; // a streaming turn owns the transcript
    writeLocal(LAST_CONVERSATION_KEY, id);
    setError(null);
    void store.get(id).then(commitActive);
  }, [commitActive, store]);

  const startNewConversation = useCallback((model: string) => {
    if (abortRef.current) return;
    setError(null);
    commitActive(null);
    writeLocal(LAST_CONVERSATION_KEY, "");
    if (model) {
      setLastModel(model);
      writeLocal(LAST_MODEL_KEY, model);
    }
  }, [commitActive]);

  const deleteConversation = useCallback((id: string) => {
    void store.remove(id);
    setSummaries(previous => previous.filter(row => row.id !== id));
    if (activeRef.current?.id === id) commitActive(null);
  }, [commitActive, store]);

  const renameConversation = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSummaries(previous => previous.map(row => (row.id === id ? { ...row, title: trimmed } : row)));
    void store.get(id).then(conversation => {
      if (!conversation) return;
      const next = { ...conversation, title: trimmed };
      applyToActive(id, () => next);
      void store.put(next);
    });
  }, [applyToActive, store]);

  const clearAllConversations = useCallback(() => {
    void store.clear();
    setSummaries([]);
    commitActive(null);
  }, [commitActive, store]);

  const setSystemPrompt = useCallback((prompt: string) => {
    const current = activeRef.current;
    if (!current) return;
    const next = { ...current, systemPrompt: prompt, updatedAt: Date.now() };
    commitActive(next);
    persist(next);
  }, [commitActive, persist]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Stream one assistant turn onto `conversation` (which must already contain
   * the user turn). Owns the abort controller, the streaming flag, the final
   * persistence, and error attribution.
   */
  const runTurn = useCallback(async (
    conversation: ChatConversation,
    model: string,
    effort: ChatEffort,
  ): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setError(null);

    const assistantId = newId("msg");
    const startedAt = Date.now();
    const assistant: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: startedAt,
      model,
      effort,
    };
    const withPlaceholder: ChatConversation = {
      ...conversation,
      model,
      effort,
      updatedAt: startedAt,
      messages: [...conversation.messages, assistant],
    };
    commitActive(withPlaceholder);

    let content = "";
    let reasoning = "";
    /**
     * Deltas arrive far faster than a useful frame rate. Buffering into a
     * microtask-scheduled flush keeps a fast stream from queuing one React
     * render per token, which is what makes long code blocks stutter.
     */
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      applyToActive(conversation.id, current => ({
        ...current,
        messages: current.messages.map(message => (
          message.id === assistantId
            ? { ...message, content, ...(reasoning ? { reasoning } : {}) }
            : message
        )),
      }));
    };
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(flush);
    };

    let failure: string | null = null;
    try {
      await sendChatTurn({
        apiBase,
        model,
        effort,
        messages: conversation.messages,
        ...(conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt } : {}),
        signal: controller.signal,
        handlers: {
          onContent(delta) { content += delta; scheduleFlush(); },
          onReasoning(delta) { reasoning += delta; scheduleFlush(); },
        },
      });
    } catch (streamError) {
      if (controller.signal.aborted) {
        // User-initiated stop: whatever streamed is kept, and the turn is marked.
      } else if (streamError instanceof ChatStreamError) {
        failure = streamError.message;
      } else {
        failure = streamError instanceof Error && streamError.message
          ? streamError.message
          : String(streamError);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }

    const stopped = controller.signal.aborted;
    const settledAt = Date.now();
    // The flush loop may have written newer state than `withPlaceholder`; take
    // whichever the ref holds for this conversation.
    const latest = activeRef.current?.id === conversation.id ? activeRef.current : withPlaceholder;
    const settled: ChatConversation = {
      ...latest,
      model,
      effort,
      updatedAt: settledAt,
      messages: latest.messages.map(message => (
        message.id === assistantId
          ? {
            ...message,
            content,
            ...(reasoning ? { reasoning } : {}),
            ...(failure ? { error: failure } : {}),
            ...(stopped ? { stopped: true } : {}),
            durationMs: settledAt - startedAt,
          }
          : message
      )),
    };
    commitActive(settled);
    persist(settled);
    if (failure) setError(failure);
  }, [apiBase, applyToActive, commitActive, persist]);

  const send = useCallback(async (input: SendTurnInput) => {
    if (abortRef.current) return;
    const text = input.text.trim();
    if (!text && input.attachments.length === 0) return;
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      content: text,
      createdAt: now,
      ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    };
    const existing = activeRef.current;
    const conversation: ChatConversation = existing
      ? {
        ...existing,
        model: input.model,
        effort: input.effort,
        updatedAt: now,
        messages: [...existing.messages, userMessage],
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      }
      : {
        id: newId("conv"),
        title: deriveTitle(text, untitledLabel),
        model: input.model,
        effort: input.effort,
        createdAt: now,
        updatedAt: now,
        messages: [userMessage],
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      };
    if (!existing) writeLocal(LAST_CONVERSATION_KEY, conversation.id);
    setLastModel(input.model);
    writeLocal(LAST_MODEL_KEY, input.model);
    setLastEffort(input.effort);
    writeLocal(LAST_EFFORT_KEY, input.effort);
    // Persist the user turn before the model answers: a crash mid-stream must
    // not lose what the user typed.
    persist(conversation);
    await runTurn(conversation, input.model, input.effort);
  }, [persist, runTurn, untitledLabel]);

  const regenerate = useCallback(async (model: string, effort: ChatEffort) => {
    if (abortRef.current) return;
    const current = activeRef.current;
    if (!current) return;
    const lastUserIndex = [...current.messages].reverse()
      .findIndex(message => message.role === "user");
    if (lastUserIndex === -1) return;
    const cutoff = current.messages.length - lastUserIndex;
    const trimmed: ChatConversation = {
      ...current,
      model,
      effort,
      updatedAt: Date.now(),
      messages: current.messages.slice(0, cutoff),
    };
    setLastModel(model);
    writeLocal(LAST_MODEL_KEY, model);
    setLastEffort(effort);
    writeLocal(LAST_EFFORT_KEY, effort);
    persist(trimmed);
    await runTurn(trimmed, model, effort);
  }, [persist, runTurn]);

  const truncateFrom = useCallback((messageId: string) => {
    if (abortRef.current) return;
    const current = activeRef.current;
    if (!current) return;
    const index = current.messages.findIndex(message => message.id === messageId);
    if (index === -1) return;
    const next: ChatConversation = {
      ...current,
      updatedAt: Date.now(),
      messages: current.messages.slice(0, index),
    };
    if (next.messages.length === 0) {
      deleteConversation(current.id);
      return;
    }
    commitActive(next);
    persist(next);
  }, [commitActive, deleteConversation, persist]);

  return {
    summaries,
    active,
    activeId: active?.id ?? null,
    loading,
    streaming,
    error,
    lastModel,
    lastEffort,
    selectConversation,
    startNewConversation,
    deleteConversation,
    renameConversation,
    clearAllConversations,
    setSystemPrompt,
    send,
    regenerate,
    truncateFrom,
    stop,
    clearError,
  };
}

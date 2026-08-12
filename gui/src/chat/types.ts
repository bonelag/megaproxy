/**
 * Chat tab domain types.
 *
 * The wire shape is OpenAI Chat Completions (that is what `/api/chat/completions`
 * relays), so a stored message is deliberately close to a wire message: the
 * transcript we persist is the transcript we replay. `attachments` is the one
 * addition — it keeps the original filename/size next to the data URL so the UI
 * can render a chip after a reload, which the wire form throws away.
 */

import type { ChatEffort } from "./effort";

export type ChatRole = "user" | "assistant" | "system";
/** An image or text file the user attached to one user turn. */
export interface ChatAttachment {
  id: string;
  name: string;
  /** MIME type as reported by the browser; may be empty for unknown types. */
  mediaType: string;
  size: number;
  /** `image` rides the wire as `image_url`; `text` is inlined into the prompt. */
  kind: "image" | "text";
  /** Data URL for images. Absent for text attachments. */
  dataUrl?: string;
  /** Decoded UTF-8 contents for text attachments. Absent for images. */
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Reasoning summary text streamed alongside the answer, when the model emits it. */
  reasoning?: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  /** Model that produced an assistant turn (a conversation may switch models mid-thread). */
  model?: string;
  /** Thinking effort this turn was sent with, shown next to the reasoning panel. */
  effort?: ChatEffort;
  /** Set when the turn ended in an error; `content` then holds whatever streamed first. */
  error?: string;
  /** Set when the user stopped the stream. */
  stopped?: boolean;
  /** Wall-clock ms from send to final token, for the assistant turn footer. */
  durationMs?: number;
}

export interface ChatConversation {
  id: string;
  /** Derived from the first user turn; the user can rename it. */
  title: string;
  model: string;
  /** Thinking effort last used in this thread; restored when it is reopened. */
  effort?: ChatEffort;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Optional per-conversation system prompt. */
  systemPrompt?: string;
}

/** Row shown in the history popover — no message bodies, so the list stays cheap. */
export interface ChatConversationSummary {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  messageCount: number;
  /** First line of the last turn, for the popover's preview line. */
  preview: string;
}

export function summarizeConversation(conversation: ChatConversation): ChatConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    preview: previewOf(conversation),
  };
}

/**
 * Preview line for the history list: the last turn's first line, whichever role
 * produced it. The last turn is what the user was doing when they left, which is
 * what makes a row recognizable — the first turn is already the title.
 */
function previewOf(conversation: ChatConversation): string {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const text = conversation.messages[index]!.content;
    const line = text.split("\n").map(part => part.trim()).find(part => part.length > 0);
    if (line) return line.length > 80 ? `${line.slice(0, 77)}…` : line;
  }
  return "";
}

export function newId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/**
 * First line of the first user turn, clipped. Titles are derived rather than
 * asked for: a model round-trip to name a thread costs a real turn, and the
 * first line is what the user would have typed anyway.
 */
export function deriveTitle(text: string, fallback: string): string {
  const firstLine = text.split("\n").map(line => line.trim()).find(line => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

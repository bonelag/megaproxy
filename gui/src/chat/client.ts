/**
 * Chat Completions SSE client for the Chat tab.
 *
 * Talks to `POST /api/chat/completions` (the management-plane relay), so the
 * GUI's own credential — attached by `installApiAuthFetch` for `/api/*` — is the
 * only auth involved. No data-plane API key is required or sent: the Chat tab
 * accepts whatever key the proxy is configured with, including none.
 *
 * The relay emits ordinary Chat Completions SSE, so this parser handles exactly
 * three deltas: `content`, `reasoning_content` (the proxy's reasoning-summary
 * bridge), and a top-level `error` object, which our translator emits mid-stream
 * instead of a fake successful completion.
 */
import type { ChatEffort } from "./effort";
import type { ChatAttachment, ChatMessage } from "./types";

/** One wire message. `content` is a string or a multimodal part array. */
type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage {
  role: "user" | "assistant" | "system";
  content: string | WireContentPart[];
}

export interface ChatStreamHandlers {
  onContent(delta: string): void;
  onReasoning(delta: string): void;
}

export class ChatStreamError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "ChatStreamError";
    this.code = code;
  }
}

/**
 * Build the wire body for one turn.
 *
 * Text attachments are inlined into the text part rather than sent as files: the
 * Chat Completions wire has no portable file part, and every model can read a
 * fenced block. Images ride as `image_url` data URLs, which the proxy's inbound
 * translator maps to a Responses `input_image`.
 */
export function toWireMessages(messages: ChatMessage[], systemPrompt?: string): WireMessage[] {
  const wire: WireMessage[] = [];
  const system = systemPrompt?.trim();
  if (system) wire.push({ role: "system", content: system });
  for (const message of messages) {
    // A failed or empty assistant turn carries no usable context and would make
    // the next request look like an assistant that answered with nothing.
    if (message.role === "assistant" && !message.content.trim()) continue;
    const text = composeMessageText(message.content, message.attachments);
    const images = (message.attachments ?? []).filter(a => a.kind === "image" && a.dataUrl);
    if (message.role === "user" && images.length > 0) {
      const parts: WireContentPart[] = [];
      if (text) parts.push({ type: "text", text });
      for (const image of images) parts.push({ type: "image_url", image_url: { url: image.dataUrl! } });
      wire.push({ role: "user", content: parts });
      continue;
    }
    if (!text) continue;
    wire.push({ role: message.role, content: text });
  }
  return wire;
}

/** Prompt text for one message: the typed text plus any inlined text attachments. */
export function composeMessageText(content: string, attachments?: ChatAttachment[]): string {
  const files = (attachments ?? []).filter(a => a.kind === "text" && typeof a.text === "string");
  if (files.length === 0) return content;
  const blocks = files.map(file => {
    // Fence length is fixed at four backticks so a file containing a triple fence
    // cannot terminate its own block early.
    return `Attached file: ${file.name}\n\`\`\`\`\n${file.text}\n\`\`\`\``;
  });
  return [content.trim(), ...blocks].filter(part => part.length > 0).join("\n\n");
}

interface SendChatTurnOptions {
  apiBase: string;
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  /** Thinking effort for this turn; omitted from the body only when absent. */
  effort?: ChatEffort;
  signal: AbortSignal;
  handlers: ChatStreamHandlers;
}

/**
 * Stream one assistant turn. Resolves when the stream ends normally (including
 * an abort, which the caller distinguishes via its own AbortSignal) and rejects
 * with a `ChatStreamError` on an HTTP failure or an in-stream error frame.
 */
export async function sendChatTurn(options: SendChatTurnOptions): Promise<void> {
  const { apiBase, model, messages, systemPrompt, temperature, effort, signal, handlers } = options;
  const body: Record<string, unknown> = {
    model,
    messages: toWireMessages(messages, systemPrompt),
    stream: true,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (effort) {
    body.reasoning_effort = effort;
    // Ask for the thinking stream explicitly. The Responses parser treats an
    // absent `reasoning.summary` as "hide the summary", so without this the
    // proxy suppresses every reasoning item and the panel would stay empty no
    // matter which rung is selected. `none` still asks for the summary: a model
    // that thinks anyway should be shown doing it.
    body.reasoning_summary = "auto";
  }

  const response = await fetch(`${apiBase}/api/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ChatStreamError("the proxy returned an empty stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; \r\n\r\n covers proxies that
      // normalize line endings on the way through.
      let boundary = nextEventBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        consumeEvent(raw, handlers);
        boundary = nextEventBoundary(buffer);
      }
    }
    if (buffer.trim()) consumeEvent(buffer, handlers);
  } finally {
    // An aborted fetch leaves the reader open; releasing it lets the connection close.
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function nextEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function consumeEvent(raw: string, handlers: ChatStreamHandlers): void {
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / keep-alive
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return;
  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    return; // a partial frame at the tail of an aborted stream
  }
  if (!frame || typeof frame !== "object") return;
  const record = frame as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const detail = error as { message?: unknown; code?: unknown };
    throw new ChatStreamError(
      typeof detail.message === "string" && detail.message ? detail.message : "the model stream failed",
      typeof detail.code === "string" ? detail.code : null,
    );
  }
  const choices = record.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") continue;
    const { content, reasoning_content: reasoning } = delta as {
      content?: unknown;
      reasoning_content?: unknown;
    };
    if (typeof reasoning === "string" && reasoning) handlers.onReasoning(reasoning);
    if (typeof content === "string" && content) handlers.onContent(content);
  }
}

async function errorFromResponse(response: Response): Promise<ChatStreamError> {
  let message = `HTTP ${response.status}`;
  let code: string | null = null;
  try {
    const text = await response.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } | string };
        if (typeof parsed.error === "string") {
          message = parsed.error;
        } else if (parsed.error && typeof parsed.error === "object") {
          if (typeof parsed.error.message === "string" && parsed.error.message) message = parsed.error.message;
          if (typeof parsed.error.code === "string") code = parsed.error.code;
        }
      } catch {
        message = text.slice(0, 400);
      }
    }
  } catch {
    /* keep the status-only message */
  }
  return new ChatStreamError(message, code);
}

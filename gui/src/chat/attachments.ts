/**
 * Attachment intake for the Chat composer.
 *
 * Two kinds, decided by MIME type and extension:
 *  - `image` → a data URL, sent as an `image_url` part. Vision models read it;
 *    non-vision models will refuse, which is the provider's answer to give.
 *  - `text`  → decoded UTF-8, inlined into the prompt as a fenced block. Every
 *    model can read that, and it needs no wire feature the proxy lacks.
 *
 * Anything else is rejected up front rather than sent as base64 the model cannot
 * interpret — a silently useless attachment is worse than a clear refusal.
 *
 * The size caps are the composer's own: they exist so one screenshot cannot
 * exceed a provider's request limit or blow the IndexedDB record. They are not a
 * security boundary; the server keeps its own body limits.
 */
import { newId, type ChatAttachment } from "./types";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_ATTACHMENTS = 8;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "csv", "tsv", "log", "env", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "js", "cjs", "mjs", "jsx", "ts", "cts", "mts", "tsx", "css", "scss", "less", "html", "htm", "xml", "svg",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sql", "graphql", "gql", "lua", "pl", "r", "dart", "vue", "svelte", "diff", "patch",
  "gitignore", "dockerfile", "makefile", "editorconfig", "properties",
]);

export type AttachmentKind = "image" | "text";

export function classifyFile(file: File): AttachmentKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  // A few structured types are text in practice but not `text/*`.
  if (type === "application/json" || type === "application/xml"
    || type === "application/x-yaml" || type === "application/yaml"
    || type === "application/javascript" || type === "application/sql") return "text";
  const name = file.name.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  // Browsers report no MIME type for many code files; an empty type plus an
  // unknown extension is the only genuinely ambiguous case, and guessing wrong
  // means sending binary garbage as a prompt. Refuse it.
  return null;
}

export type AttachmentError =
  | { reason: "unsupported"; name: string }
  | { reason: "too-large"; name: string; limit: number }
  | { reason: "too-many"; limit: number }
  | { reason: "read-failed"; name: string };

export interface ReadAttachmentsResult {
  attachments: ChatAttachment[];
  errors: AttachmentError[];
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("unexpected reader result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Read `files` into attachments, reporting per-file failures instead of throwing:
 * one unreadable file in a multi-select must not discard the readable ones.
 */
export async function readAttachments(
  files: readonly File[],
  alreadyAttached: number,
): Promise<ReadAttachmentsResult> {
  const attachments: ChatAttachment[] = [];
  const errors: AttachmentError[] = [];
  let budget = MAX_ATTACHMENTS - alreadyAttached;
  for (const file of files) {
    if (budget <= 0) {
      errors.push({ reason: "too-many", limit: MAX_ATTACHMENTS });
      break;
    }
    const kind = classifyFile(file);
    if (!kind) {
      errors.push({ reason: "unsupported", name: file.name });
      continue;
    }
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (file.size > limit) {
      errors.push({ reason: "too-large", name: file.name, limit });
      continue;
    }
    try {
      if (kind === "image") {
        const dataUrl = await readAsDataUrl(file);
        attachments.push({
          id: newId("att"),
          name: file.name || "image",
          mediaType: file.type || "image/png",
          size: file.size,
          kind: "image",
          dataUrl,
        });
      } else {
        const text = await file.text();
        attachments.push({
          id: newId("att"),
          name: file.name || "file.txt",
          mediaType: file.type || "text/plain",
          size: file.size,
          kind: "text",
          text,
        });
      }
      budget -= 1;
    } catch {
      errors.push({ reason: "read-failed", name: file.name });
    }
  }
  return { attachments, errors };
}

/** Files carried by a paste event — screenshots arrive this way, not via the picker. */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0 && data.files) files.push(...data.files);
  return files;
}

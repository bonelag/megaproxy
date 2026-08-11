/**
 * Compose provider.headers from the Settings / Add-provider form.
 *
 * User-Agent is a convenience field that maps to headers["User-Agent"].
 * Extra rows are arbitrary non-auth metadata; the server still rejects
 * sensitive names (Authorization, Cookie, x-api-key, …) on save.
 */

export type ProviderHeaderRow = {
  /** Stable React key; not persisted. */
  id: string;
  name: string;
  value: string;
};

export type ComposeProviderHeadersResult =
  | { ok: true; headers: Record<string, string> | null }
  | { ok: false; error: "empty-name" | "duplicate" | "user-agent-row" | "crlf" };

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function newHeaderRow(name = "", value = ""): ProviderHeaderRow {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `h-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    value,
  };
}

/**
 * Build the headers object the management API expects.
 * Returns `headers: null` when the form is empty (caller maps that to clear).
 */
export function composeProviderHeaders(
  userAgent: string,
  rows: readonly ProviderHeaderRow[],
): ComposeProviderHeadersResult {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  const ua = userAgent.trim();
  if (ua) {
    if (/[\r\n]/.test(ua)) return { ok: false, error: "crlf" };
    headers["User-Agent"] = ua;
    seen.add("user-agent");
  }

  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value;
    if (!name && !value.trim()) continue;
    if (!name) return { ok: false, error: "empty-name" };
    if (!HEADER_NAME_PATTERN.test(name)) return { ok: false, error: "empty-name" };
    if (/[\r\n]/.test(value)) return { ok: false, error: "crlf" };
    const lower = name.toLowerCase();
    if (lower === "user-agent") return { ok: false, error: "user-agent-row" };
    if (seen.has(lower)) return { ok: false, error: "duplicate" };
    seen.add(lower);
    headers[name] = value;
  }

  return { ok: true, headers: Object.keys(headers).length > 0 ? headers : null };
}


/** Split a stored headers map into the UA field + remaining editable rows. */
export function splitProviderHeaders(
  headers: Record<string, string> | null | undefined,
): { userAgent: string; rows: ProviderHeaderRow[] } {
  if (!headers) return { userAgent: "", rows: [] };
  let userAgent = "";
  const rows: ProviderHeaderRow[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "user-agent") {
      userAgent = value;
      continue;
    }
    rows.push(newHeaderRow(name, value));
  }
  return { userAgent, rows };
}

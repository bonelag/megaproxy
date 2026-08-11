/**
 * Apply user-configured provider.headers onto an outbound request.
 *
 * Custom endpoints (and any provider with headers set) must send these on every
 * upstream call — chat, discovery, compact, images, sidecars. Call this LAST so
 * User-Agent / fingerprint keys win over adapter defaults.
 */

export function applyProviderHeaders(
  headers: Record<string, string>,
  provider: { headers?: Record<string, string> } | null | undefined,
): Record<string, string> {
  if (!provider?.headers) return headers;
  for (const [name, value] of Object.entries(provider.headers)) {
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

/** Same merge for the Fetch `Headers` object used by compact / pool paths. */
export function applyProviderHeadersToHeadersInit(
  headers: Headers,
  provider: { headers?: Record<string, string> } | null | undefined,
): Headers {
  if (!provider?.headers) return headers;
  for (const [name, value] of Object.entries(provider.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

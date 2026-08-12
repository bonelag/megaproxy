/**
 * Compact relative age for history rows: `1m`, `7d`, then an absolute date.
 *
 * Its own module because the history popover only exports components (the
 * fast-refresh rule), and because the rounding is worth testing directly.
 */

/** Compact age for the right edge of a row: 1m, 7d, then an absolute date. */
export function relativeAge(timestamp: number, locale: string, now = Date.now()): string {
  const deltaMs = Math.max(0, now - timestamp);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  // Floor at one minute rather than formatting 0: `numeric: "auto"` would say
  // "this minute", which is both wider than the column and inconsistent with the
  // numeric rungs below it.
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  if (minutes < 60) return trimAgo(formatter.format(-minutes, "minute"));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return trimAgo(formatter.format(-hours, "hour"));
  const days = Math.floor(hours / 24);
  if (days < 30) return trimAgo(formatter.format(-days, "day"));
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(timestamp);
}

/**
 * Narrow relative formats still say "1d ago" in English. The row has ~40px for
 * this, so drop a trailing "ago"-style word while leaving locales that put the
 * marker first (or use none) alone.
 */
function trimAgo(text: string): string {
  return text.replace(/\s*ago$/i, "");
}

// What the context meter says: "38% · 76k / 200k". Pure, so the numbers are tested apart from the ring.

/** One reading of the meter. */
export interface ContextReading {
  /** How full the context is, as a whole percentage. */
  readonly percent: number
  /** How full the context is, from 0 to 1, for the ring. */
  readonly fraction: number
  /** The tokens used, e.g. `76k`. */
  readonly used: string
  /** The window, e.g. `200k` or `1M`. */
  readonly window: string
}

const THOUSAND = 1_000
const MILLION = 1_000_000

/**
 * A token count as the meter shows it: whole thousands (`0k`, `76k`, `999k`), then millions to one decimal place
 * without a trailing zero (`1M`, `1.2M`). A count that rounds to 1000k shows as `1M`.
 */
export function formatTokens(tokens: number): string {
  const thousands = Math.round(tokens / THOUSAND)
  if (thousands < THOUSAND) return `${String(thousands)}k`
  const millions = Math.round(tokens / (MILLION / 10)) / 10
  return `${String(millions)}M`
}

/** The meter's reading for `usedTokens` of a `windowTokens` window. A new task reads `0% · 0k / 200k`. */
export function contextReading(usedTokens: number, windowTokens: number): ContextReading {
  const fraction = windowTokens > 0 ? Math.min(1, Math.max(0, usedTokens / windowTokens)) : 0
  return {
    percent: Math.round(fraction * 100),
    fraction,
    used: formatTokens(usedTokens),
    window: formatTokens(windowTokens),
  }
}

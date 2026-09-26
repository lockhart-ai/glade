// What the context meter says: "38% · 76k / 200k", and where the SDK will compact. Pure, so the numbers are tested apart
// from the ring and the popover.
import { autoCompactThreshold } from '../../shared/contextWindow'
import { AutoCompactKind, type AutoCompact } from '../../shared/domain'

/** Where the SDK compacts automatically, as a share of the window. */
export interface ThresholdReading {
  /** As a whole percentage of the window: 84 for 167k of 200k. */
  readonly percent: number
  /** From 0 to 1, for the popover's marker. */
  readonly fraction: number
}

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
  /** Where the SDK compacts automatically; null when auto-compact is switched off. */
  readonly threshold: ThresholdReading | null
  /** Whether the context is near that threshold, or past it: the ring and the popover turn purple. Never when off. */
  readonly nearThreshold: boolean
}

/**
 * How near the auto-compact threshold the context has to be for the meter to turn purple: within this much of the
 * window below it. The design's purple ring reads 97% with the threshold at 99%; a tenth of the window, 20k of 200k,
 * gives some warning before the SDK compacts, without the ring going purple for most of a session.
 */
export const NEAR_THRESHOLD_FRACTION = 0.1

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

/** `part` of `whole`, from 0 to 1; 0 of an empty whole. */
function fractionOf(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0
}

/**
 * Where the SDK compacts automatically, in tokens: what it last said (`Task.autoCompact`), or, before it has, its
 * default for the window. Null when auto-compact is switched off.
 */
export function thresholdTokens(windowTokens: number, autoCompact: AutoCompact | null): number | null {
  if (autoCompact === null) return autoCompactThreshold(windowTokens)
  switch (autoCompact.kind) {
    case AutoCompactKind.On:
      return autoCompact.thresholdTokens
    case AutoCompactKind.Off:
      return null
  }
}

/**
 * The meter's reading for `usedTokens` of a `windowTokens` window, with the SDK compacting as `autoCompact` says (its
 * default until it says). A new task reads `0% · 0k / 200k`.
 */
export function contextReading(
  usedTokens: number,
  windowTokens: number,
  autoCompact: AutoCompact | null = null,
): ContextReading {
  const fraction = fractionOf(usedTokens, windowTokens)
  const tokens = thresholdTokens(windowTokens, autoCompact)
  const thresholdFraction = tokens === null ? null : fractionOf(tokens, windowTokens)
  return {
    percent: Math.round(fraction * 100),
    fraction,
    used: formatTokens(usedTokens),
    window: formatTokens(windowTokens),
    threshold:
      thresholdFraction === null ? null : { percent: Math.round(thresholdFraction * 100), fraction: thresholdFraction },
    nearThreshold:
      thresholdFraction !== null && windowTokens > 0 && fraction >= thresholdFraction - NEAR_THRESHOLD_FRACTION,
  }
}

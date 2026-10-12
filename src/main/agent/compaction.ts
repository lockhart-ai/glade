/**
 * What the runner reads of compaction from the SDK (`docs/sdk-notes.md` §5), parsed at the boundary: where the session
 * compacts automatically (`getContextUsage`), what a compaction carried over (the `PostCompact` hook's summary), and
 * (#573) the same call's own `totalTokens` estimate, the last-resort context figure for an OpenRouter turn with
 * nothing more honest to go on.
 */
import { z } from 'zod'
import { AutoCompactKind, type AutoCompact } from '../../shared/domain'

// `autoCompactThreshold` is missing while auto-compact is off; a malformed one is as good as missing.
const contextUsage = z.looseObject({
  isAutoCompactEnabled: z.boolean(),
  autoCompactThreshold: z.int().nonnegative().optional().catch(undefined),
})

/**
 * Where the session compacts automatically, from what `getContextUsage` answered: at its threshold, or not at all when
 * auto-compact is off. Undefined when the answer doesn't say (it isn't the SDK's shape, or has auto-compact on with no
 * threshold), so the last known value stays.
 */
export function autoCompactFrom(raw: unknown): AutoCompact | undefined {
  const parsed = contextUsage.safeParse(raw)
  if (!parsed.success) return undefined
  const { isAutoCompactEnabled, autoCompactThreshold } = parsed.data
  if (!isAutoCompactEnabled) return { kind: AutoCompactKind.Off }
  return autoCompactThreshold === undefined
    ? undefined
    : { kind: AutoCompactKind.On, thresholdTokens: autoCompactThreshold }
}

// A malformed or missing `totalTokens` is as good as the SDK not saying.
const contextEstimate = z.looseObject({ totalTokens: z.number().nonnegative() })

/**
 * The SDK's own local estimate of the context in use, from the same `getContextUsage` answer, for #573's last
 * resort: a multi-request OpenRouter turn whose messages, and whose result, give no honest per-request figure.
 * Probed (`docs/sdk-notes.md`, "A turn's `result.usage`…"): it tracks the last response's own real total once that
 * exceeds a local baseline (system prompt, skills, slash commands), so it is never a sum across requests — but it
 * is stale right after a compaction, so the caller never asks then. Null when the answer doesn't say.
 */
export function contextEstimateFrom(raw: unknown): number | null {
  const parsed = contextEstimate.safeParse(raw)
  return parsed.success ? parsed.data.totalTokens : null
}

/** Whether two answers say the same thing, so an unchanged one needn't touch the task. */
export function sameAutoCompact(a: AutoCompact | null, b: AutoCompact): boolean {
  if (a?.kind !== b.kind) return false
  switch (a.kind) {
    case AutoCompactKind.On:
      return b.kind === AutoCompactKind.On && a.thresholdTokens === b.thresholdTokens
    case AutoCompactKind.Off:
      return true
  }
}

const SUMMARY_BLOCK = /<summary>([\s\S]*?)<\/summary>/
const ANALYSIS_BLOCK = /<analysis>[\s\S]*?<\/analysis>/g

/**
 * What a compaction carried over, from the summary it wrote: the model writes its analysis, then the summary the
 * agent carries on from (`<analysis>…</analysis><summary>…</summary>`), and only the summary is carried over. Without
 * a summary block, the text less any analysis; trimmed, so an empty one is empty.
 */
export function carriedOver(summary: string): string {
  const block = SUMMARY_BLOCK.exec(summary)
  return (block === null ? summary.replace(ANALYSIS_BLOCK, '') : (block[1] ?? '')).trim()
}

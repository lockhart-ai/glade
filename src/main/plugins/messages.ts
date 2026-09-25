/** Checking what a plugin posts (`window.glade.post`), which arrives from its page as `unknown`. */
import { MAX_PLUGIN_STATUS, type PluginMessage } from '../../shared/plugin-api'
import { pluginMessageSchema } from '../../shared/plugin-api-schema'
import { describeIssues } from '../bridge/requests'

export type ParsedPluginMessage =
  { readonly ok: true; readonly message: PluginMessage } | { readonly ok: false; readonly reason: string }

/** A plugin's message, or why it's dropped: it isn't one of the messages in `docs/plugin-api.md`. */
export function parsePluginMessage(raw: unknown): ParsedPluginMessage {
  const parsed = pluginMessageSchema.safeParse(raw)
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: describeIssues(parsed.error) }
}

/** A status as the panel header shows it: its first `MAX_PLUGIN_STATUS` characters, never half of one. */
export function cutStatus(text: string): string {
  const characters = Array.from(text)
  return characters.length <= MAX_PLUGIN_STATUS ? text : characters.slice(0, MAX_PLUGIN_STATUS).join('')
}

/** How many messages a plugin may post at once, and how quickly it earns more. */
export interface RateLimit {
  /** The most it may post in a burst. */
  readonly burst: number
  /** How many more it may post each second, up to `burst`. */
  readonly perSecond: number
}

/** A plugin's messages: a burst of 50, then 20 a second. More than any plugin needs; a flood is dropped. */
export const PLUGIN_RATE_LIMIT: RateLimit = { burst: 50, perSecond: 20 }

/** Counts a plugin's messages against its limit. */
export interface RateLimiter {
  /** Whether one more message is allowed now; if it is, it's counted. */
  take(): boolean
}

/** A token bucket: `burst` tokens, refilled at `perSecond`, one per message. */
export function createRateLimiter({ burst, perSecond }: RateLimit, now: () => number = Date.now): RateLimiter {
  let tokens = burst
  let last = now()
  return {
    take() {
      const time = now()
      tokens = Math.min(burst, tokens + ((time - last) / 1000) * perSecond)
      last = time
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

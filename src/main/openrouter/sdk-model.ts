import { createHash } from 'node:crypto'

/** Keep Glade's persisted model/provider identifier separate from the SDK's internal model aliases. */
export function openRouterSdkModel(choiceId: string): string {
  return `glade-or-${createHash('sha256').update(choiceId).digest('hex').slice(0, 24)}`
}

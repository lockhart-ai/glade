/**
 * The relaunch notice (`docs/design/screens/18-relaunch.png`): after Glade quit unexpectedly with tasks mid-turn, it
 * says so, and that they picked up where they left off. Main saves it on launch in the `relaunch_notice` UI state, and
 * it stays until you dismiss it, across relaunches too.
 */

/** What the notice says: the tasks whose agents picked their work back up on launch. */
export interface RelaunchNotice {
  /** In the order they were created. At least one. */
  readonly taskIds: readonly string[]
}

/** The notice as its UI state value. */
export function serializeRelaunchNotice(notice: RelaunchNotice): string {
  return JSON.stringify({ taskIds: notice.taskIds })
}

/** The notice a UI state value holds, or null for none: unset, dismissed (empty), or not a notice. */
export function parseRelaunchNotice(value: string | undefined): RelaunchNotice | null {
  if (value === undefined || value === '') return null
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    return null
  }
  const taskIds: unknown = typeof json === 'object' && json !== null ? Reflect.get(json, 'taskIds') : undefined
  if (!Array.isArray(taskIds) || taskIds.length === 0) return null
  if (!taskIds.every((id): id is string => typeof id === 'string')) return null
  return { taskIds }
}

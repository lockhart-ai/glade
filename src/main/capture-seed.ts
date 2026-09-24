/**
 * Sample data for screenshots: `npm run screenshot -- --seed <fixture>` fills the capture's throwaway database from a
 * JSON fixture before the window opens, so a capture can show a populated app. Only capture mode uses it.
 */
import { readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { TaskState, UiStateKey, type EpochMs } from '../shared/domain'
import { createTask, updateTask } from './db/repositories/tasks'
import { setUiState } from './db/repositories/ui-state'
import { createWorkspace } from './db/repositories/workspaces'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './tasks/defaults'

const MINUTE = 60_000

/** One sample task. Its times are relative to the capture, so relative times read the same on every run. */
export interface SeedTask {
  readonly title: string
  readonly objective?: string | undefined
  readonly status?: string | undefined
  readonly state?: TaskState | undefined
  readonly pinned?: boolean | undefined
  readonly unread?: boolean | undefined
  /** How long before the capture the task was last updated. */
  readonly minutesAgo: number
  /** Select this task. */
  readonly selected?: boolean | undefined
}

/** A fixture: one workspace, opened, and its tasks. */
export interface CaptureSeed {
  readonly workspace: { readonly name: string; readonly rootPath: string }
  readonly tasks: readonly SeedTask[]
}

const seedSchema: z.ZodType<CaptureSeed> = z.strictObject({
  workspace: z.strictObject({ name: z.string(), rootPath: z.string() }),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      objective: z.string().optional(),
      status: z.string().optional(),
      state: z.enum(TaskState).optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      minutesAgo: z.number().nonnegative(),
      selected: z.boolean().optional(),
    }),
  ),
})

/** Reads and checks a seed fixture. Throws when it can't be read or isn't a valid fixture. */
export function readSeed(path: string): CaptureSeed {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`the seed ${path} can't be read: ${(error as Error).message}`, { cause: error })
  }
  const parsed = seedSchema.safeParse(json)
  if (!parsed.success) throw new Error(`the seed ${path} is invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** Writes a seed into the database as if it had been used up to `now`: the workspace open, the selected task shown. */
export function applySeed(db: Database, seed: CaptureSeed, now: EpochMs = Date.now()): void {
  db.transaction(() => {
    const workspace = createWorkspace(db, seed.workspace, now)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    for (const sample of seed.tasks) {
      const at = now - sample.minutesAgo * MINUTE
      const task = createTask(db, { workspaceId: workspace.id, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT }, at)
      updateTask(
        db,
        task.id,
        {
          title: sample.title,
          objective: sample.objective ?? '',
          status: sample.status ?? '',
          state: sample.state ?? TaskState.Active,
          pinned: sample.pinned ?? false,
          unread: sample.unread ?? false,
        },
        at,
      )
      if (sample.selected === true) setUiState(db, { key: UiStateKey.SelectedTaskId, value: task.id })
    }
  })()
}

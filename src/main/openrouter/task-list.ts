import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface TaskListOptions {
  readonly taskId: string
  readonly sessionId: string | null
  readonly dataDir: string
  readonly configDir: string
  readonly legacyConfigDir: string
  /**
   * Only a cross-source session created the shared list before #593; since, every main session of a task does, and an
   * ordinary start may reuse one already present.
   */
  readonly create?: boolean
  /**
   * The highest todo id Glade already holds for the task (#593). When the shared list is first created, its high-water
   * mark is raised past it, so a number an old generation's list used is never given again.
   */
  readonly highestTodoId?: number
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
const cleanId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '-')

/** The high-water mark file inside a list folder, which the CLI numbers new todos past. */
const HIGH_WATERMARK = '.highwatermark'

/**
 * Raises a staged list's high-water mark past the highest todo id Glade already holds, so a number an old generation's
 * list used is never given again (#593). A mark that already stands higher, or Glade holding no numbered todo, leaves
 * it as it is.
 */
async function raiseHighWatermark(stage: string, highestTodoId: number | undefined): Promise<void> {
  if (highestTodoId === undefined) return
  const file = join(stage, HIGH_WATERMARK)
  const had = await readFile(file, 'utf8')
    .then((text) => Number.parseInt(text, 10))
    .catch(() => undefined)
  if (had !== undefined && Number.isFinite(had) && had >= highestTodoId + 1) return
  await writeFile(file, String(highestTodoId + 1))
}

/** Both SDK configurations use one task list, including its high-water mark and locks. Auth stays separate. */
export async function sdkTaskList(options: TaskListOptions): Promise<string | undefined> {
  const { dataDir, configDir, taskId, sessionId, legacyConfigDir } = options
  const root = join(dataDir, 'sdk-task-lists')
  const target = join(root, cleanId(taskId))
  if (!(await exists(target))) {
    if (options.create === false) return undefined
    await mkdir(root, { recursive: true, mode: 0o700 })
    const stage = await mkdtemp(join(root, '.seed-'))
    try {
      if (sessionId !== null) {
        const legacy = join(legacyConfigDir, 'tasks', cleanId(sessionId))
        if (await exists(legacy)) await cp(legacy, stage, { recursive: true, dereference: false })
      }
      await raiseHighWatermark(stage, options.highestTodoId)
      try {
        await rename(stage, target)
      } catch (error) {
        if (!(await exists(target))) throw error
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  const listId = `glade-${cleanId(taskId)}`
  const folder = join(configDir, 'tasks')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const link = join(folder, listId)
  if (await exists(link)) {
    if ((await readlink(link)) !== target) throw new Error('The SDK task-list link points at a different task.')
  } else {
    try {
      await symlink(target, link, 'dir')
    } catch (error) {
      if ((await readlink(link).catch(() => null)) !== target) throw error
    }
  }
  return listId
}

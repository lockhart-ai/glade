import { cp, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

interface TaskListOptions {
  readonly taskId: string
  readonly sessionId: string | null
  readonly dataDir: string
  readonly configDir: string
  readonly legacyConfigDir: string
  /** Only a cross-source session creates the shared list; ordinary starts may reuse one already present. */
  readonly create?: boolean
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

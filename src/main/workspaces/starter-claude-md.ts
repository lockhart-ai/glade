import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `CLAUDE.md` Glade writes into a new workspace's root when it has none. Where a task keeps its files is a
 * convention described here for the agent, not something Glade enforces; the user is free to change it.
 */
export const STARTER_CLAUDE_MD = `# Workspace conventions

This folder is a Glade workspace. Every Glade task's agent runs in this folder.

- Each task keeps its files in \`tasks/<task-id>-<slug>/\` under this folder, where \`<slug>\` is a short kebab-case
  form of the task's title.
- When a task needs a git worktree, create it inside the task's folder.
- Leave other tasks' folders alone.
`

/**
 * Writes the starter `CLAUDE.md` into `rootPath` unless a `CLAUDE.md` is already there. Never overwrites or changes an
 * existing one: the file is created exclusively, so one that appears in the meantime is left alone too.
 *
 * @returns Whether the starter was written.
 */
export function seedClaudeMd(rootPath: string): boolean {
  try {
    writeFileSync(join(rootPath, 'CLAUDE.md'), STARTER_CLAUDE_MD, { flag: 'wx' })
    return true
  } catch (error) {
    if (isAlreadyThere(error)) return false
    throw error
  }
}

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'EEXIST'
}

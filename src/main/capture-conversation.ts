/**
 * Seeds a test mode's throwaway database with a conversation, so a capture shows a populated task: a workspace, a task
 * in it, selected, and a first message played through the agent script to its end (or to where it waits for Stop).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { UiStateKey, type Task } from '../shared/domain'
import type { AgentRunner } from './agent/runner'
import type { Emit } from './bridge/events'
import { setUiState } from './db/repositories/ui-state'
import { createTask } from './tasks/service'
import { createWorkspaceAt, openWorkspace } from './workspaces/workspaces'

/** The conversation to seed. */
export interface ConversationSeed {
  /** The user's first message. */
  readonly message: string
}

export interface SeedContext {
  readonly db: Database
  readonly emit: Emit
  readonly runner: AgentRunner
  /** Resolves once the agent has nothing left to do for now. */
  readonly whenIdle: () => Promise<void>
  /** A folder to make the workspace's root in. */
  readonly folder: string
}

/** The seeded workspace's folder name: the designs' sample workspace. */
export const SEED_WORKSPACE_FOLDER = 'acme-api'

/** Seeds the conversation and resolves with its task once the agent has played its turn. */
export async function seedConversation(context: SeedContext, seed: ConversationSeed): Promise<Task> {
  const { db, runner } = context
  const root = join(context.folder, SEED_WORKSPACE_FOLDER)
  mkdirSync(root, { recursive: true })
  const { workspace } = createWorkspaceAt(db, root)
  openWorkspace(db, workspace.id)
  const task = createTask(context, workspace.id)
  setUiState(db, { key: UiStateKey.SelectedTaskId, value: task.id })
  runner.send(task.id, seed.message)
  await context.whenIdle()
  return task
}

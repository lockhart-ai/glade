import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { modelName, sameModel } from '../../shared/models'
import { AgentSource, agentSource } from '../../shared/openrouter'
import { CommandFailure } from '../bridge/errors'
import { getOpenRouterChoice, openRouterConnected } from '../db/repositories/openrouter'
import { Row } from '../db/repositories/rows'
import { appendNarration } from '../db/repositories/tool-events'
import type { NarrationEvent } from '../../shared/domain'
import { listModels } from './models'

export interface PendingModelSwitch {
  readonly previous: string
  readonly next: string
  readonly label: string
}

export function validateModel(db: Database, model: string): void {
  if (agentSource(model) !== AgentSource.OpenRouter) return
  const choice = getOpenRouterChoice(db, model)
  if (!openRouterConnected(db) || choice?.enabled !== true) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'Enable this OpenRouter model in Settings → Models.')
  }
}

export function pendingModelSwitch(db: Database, taskId: string): PendingModelSwitch | null {
  const raw = db
    .prepare('SELECT previous_model, next_model, label FROM task_model_switches WHERE task_id = ?')
    .get(taskId)
  if (raw === undefined) return null
  const row = new Row('task_model_switches', raw)
  return { previous: row.text('previous_model'), next: row.text('next_model'), label: row.text('label') }
}

export function stageModelSwitch(db: Database, taskId: string, previous: string, next: string): void {
  const original = pendingModelSwitch(db, taskId)?.previous ?? previous
  if (sameModel(listModels(db), original, next)) {
    db.prepare('DELETE FROM task_model_switches WHERE task_id = ?').run(taskId)
    return
  }
  const choice = getOpenRouterChoice(db, next)
  const label =
    choice === undefined
      ? modelName(listModels(db), next)
      : `${choice.model.name} · ${choice.provider.name} (OpenRouter)`
  db.prepare('INSERT OR REPLACE INTO task_model_switches VALUES (?, ?, ?, ?)').run(taskId, original, next, label)
}

/** Both the timeline entry and its immutable selections commit together; restart cannot duplicate it. */
export function completeModelSwitch(db: Database, taskId: string, model: string, turn: number): NarrationEvent | null {
  return db.transaction(() => {
    const pending = pendingModelSwitch(db, taskId)
    if (pending?.next !== model) return null
    const event = appendNarration(db, { taskId, turn: Math.max(1, turn), text: `Switched model to ${pending.label}` })
    db.prepare('INSERT INTO model_switch_history VALUES (?, ?, ?, ?)').run(
      event.id,
      pending.previous,
      pending.next,
      pending.label,
    )
    db.prepare('DELETE FROM task_model_switches WHERE task_id = ?').run(taskId)
    return event
  })()
}

export function validateSubagentModel(db: Database, parent: string, child: string | null | undefined): void {
  if (child == null) return
  validateModel(db, child)
  if (agentSource(parent) !== agentSource(child))
    throw new CommandFailure(
      BridgeErrorCode.InvalidRequest,
      'Native subagents must use the task’s source. Choose Same as task or a model from that source.',
    )
}

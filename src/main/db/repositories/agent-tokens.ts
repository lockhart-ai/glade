import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import type { AgentTokenTotal } from '../../../shared/domain'
import { Row } from './rows'

/** An assistant message's tokens to add to an agent tab's total. */
export interface AgentTokensAdd {
  readonly taskId: string
  /** The agent the message ran on: its `Agent` call's `tool_use` id, or null for Main, the task's own agent. */
  readonly agentId: string | null
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The row the upsert gives back, read once. */
const returned = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
})

/** The empty `agent_id` that stands for Main in the table. */
const MAIN_AGENT_ID = ''

/**
 * Adds `add`'s tokens into the agent tab's persisted total (#566) and gives the total back, so the runner can send the
 * tab what it now shows without reading it again.
 */
export function addAgentTokens(db: Database, add: AgentTokensAdd): AgentTokenTotal {
  const returnedRow = db
    .prepare(
      `INSERT INTO agent_token_totals (task_id, agent_id, input_tokens, output_tokens) VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, agent_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
      RETURNING input_tokens, output_tokens`,
    )
    .get(add.taskId, add.agentId ?? MAIN_AGENT_ID, add.inputTokens, add.outputTokens)
  const row = returned.parse(returnedRow)
  return { agentId: add.agentId, inputTokens: row.input_tokens, outputTokens: row.output_tokens }
}

/** A task's agent tab totals, Main's first, in the order the agents started. */
export function agentTokenTotals(db: Database, taskId: string): readonly AgentTokenTotal[] {
  return db
    .prepare('SELECT agent_id, input_tokens, output_tokens FROM agent_token_totals WHERE task_id = ? ORDER BY rowid')
    .all(taskId)
    .map((raw): AgentTokenTotal => {
      const row = new Row('agent_token_totals', raw)
      const agentId = row.text('agent_id')
      return {
        agentId: agentId === MAIN_AGENT_ID ? null : agentId,
        inputTokens: row.integer('input_tokens'),
        outputTokens: row.integer('output_tokens'),
      }
    })
}

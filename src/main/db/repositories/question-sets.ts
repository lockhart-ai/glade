import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  QuestionSetState,
  type EpochMs,
  type Question,
  type QuestionReply,
  type QuestionSet,
} from '../../../shared/domain'
import { questionReplySchema, questionsSchema } from '../../questions/schema'
import { Row, RowError } from './rows'

export interface NewQuestionSet {
  readonly taskId: string
  readonly turn: number
  /** What the agent said before its questions; none when left out. */
  readonly preamble?: string | undefined
  readonly questions: readonly Question[]
}

/** How a question set closes: answered with your reply, or withdrawn without one. */
export type QuestionSetClosing =
  | { readonly state: QuestionSetState.Answered; readonly reply: QuestionReply }
  | { readonly state: QuestionSetState.Withdrawn }

const TABLE = 'question_sets'
const COLUMNS = 'id, task_id, turn, preamble, questions, state, reply, created_at, closed_at'
const STATES = Object.values(QuestionSetState)

/** A JSON column holding a value `schema` parses. */
function parsed<T>(row: Row, column: string, schema: z.ZodType<T>): T {
  const result = schema.safeParse(row.json(column))
  if (!result.success) throw new RowError(TABLE, column, z.prettifyError(result.error))
  return result.data
}

function parseQuestionSet(raw: unknown): QuestionSet {
  const row = new Row(TABLE, raw)
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    turn: row.integer('turn'),
    preamble: row.nullableText('preamble'),
    questions: parsed(row, 'questions', questionsSchema),
    state: row.oneOf('state', STATES),
    reply: row.nullableText('reply') === null ? null : parsed(row, 'reply', questionReplySchema),
    createdAt: row.integer('created_at'),
    closedAt: row.nullableInteger('closed_at'),
  }
}

/** Opens a question set for a task. */
export function appendQuestionSet(db: Database, input: NewQuestionSet, now: EpochMs = Date.now()): QuestionSet {
  const { preamble, ...rest } = input
  const set: QuestionSet = {
    id: randomUUID(),
    ...rest,
    preamble: preamble ?? null,
    state: QuestionSetState.Open,
    reply: null,
    createdAt: now,
    closedAt: null,
  }
  db.prepare(
    `INSERT INTO ${TABLE} (${COLUMNS})
    VALUES (@id, @taskId, @turn, @preamble, @questions, @state, NULL, @createdAt, NULL)`,
  ).run({ ...set, questions: JSON.stringify(set.questions) })
  return set
}

export function getQuestionSet(db: Database, id: string): QuestionSet | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseQuestionSet(row)
}

/** A task's question sets, in the order they were asked. */
export function listQuestionSets(db: Database, taskId: string): QuestionSet[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? ORDER BY created_at, rowid`)
    .all(taskId)
    .map(parseQuestionSet)
}

/** The task's open question set, or undefined when it has none. */
export function getOpenQuestionSet(db: Database, taskId: string): QuestionSet | undefined {
  const row: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? AND state = ? ORDER BY created_at, rowid LIMIT 1`)
    .get(taskId, QuestionSetState.Open)
  return row === undefined ? undefined : parseQuestionSet(row)
}

/** Every task's open question sets, oldest first. On launch, these are the questions the app quit on. */
export function listOpenQuestionSets(db: Database): QuestionSet[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE state = ? ORDER BY created_at, rowid`)
    .all(QuestionSetState.Open)
    .map(parseQuestionSet)
}

/**
 * Closes an open question set: answered with a reply, or withdrawn. Answers with it as it now is, or undefined when
 * there's no such set or it was already closed.
 */
export function closeQuestionSet(
  db: Database,
  id: string,
  closing: QuestionSetClosing,
  now: EpochMs = Date.now(),
): QuestionSet | undefined {
  const reply = closing.state === QuestionSetState.Answered ? JSON.stringify(closing.reply) : null
  const { changes } = db
    .prepare(`UPDATE ${TABLE} SET state = ?, reply = ?, closed_at = ? WHERE id = ? AND state = ?`)
    .run(closing.state, reply, now, id, QuestionSetState.Open)
  return changes === 0 ? undefined : getQuestionSet(db, id)
}

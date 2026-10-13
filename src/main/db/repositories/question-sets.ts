import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  QuestionSetState,
  type EpochMs,
  type Question,
  type QuestionCardDraft,
  type QuestionReply,
  type QuestionSet,
} from '../../../shared/domain'
import { questionDraftContentsSchema, questionReplySchema, questionsSchema } from '../../questions/schema'
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

/**
 * What you've filled in on the task's open question card and not sent yet, with which set it's for: null when the task
 * has no open set, or its card has nothing in it. The draft goes with its set, so it can never show on another card.
 */
export function getOpenQuestionDraft(db: Database, taskId: string): QuestionCardDraft | null {
  const row: unknown = db
    .prepare('SELECT id, draft FROM question_sets WHERE task_id = ? AND state = ? ORDER BY created_at, rowid LIMIT 1')
    .get(taskId, QuestionSetState.Open)
  if (row === undefined) return null
  const parsed = new Row(TABLE, row)
  const stored = parsed.nullableText('draft')
  if (stored === null) return null
  const contents = questionDraftContentsSchema.safeParse(parsed.json('draft'))
  if (!contents.success) throw new RowError(TABLE, 'draft', z.prettifyError(contents.error))
  return { questionSetId: parsed.text('id'), ...contents.data }
}

/**
 * Stores what's filled in on a task's open question card, on the set's row. A draft with nothing in it, or null, stores
 * none. Answers false, and stores nothing, when the task has no such open set: a card that has just been answered or
 * withdrawn can still be saving its draft, and its set no longer takes one.
 */
export function setQuestionDraft(db: Database, taskId: string, draft: QuestionCardDraft | null): boolean {
  // What the card has left counts as nothing: a question's text answer does when it trims to blank, as the card itself
  // counts it (`isAnswered` in the renderer).
  const answered =
    draft !== null &&
    Object.values(draft.draft).some((answer) => (typeof answer === 'string' ? answer.trim() !== '' : answer.length > 0))
  const contents =
    draft === null || (!answered && draft.anythingElse.trim() === '')
      ? null
      : JSON.stringify({ draft: draft.draft, anythingElse: draft.anythingElse })
  // Without a set to clear (nothing is left, and the card is gone), the open set's draft goes; with one, only its own
  // row is touched.
  const { changes } =
    contents === null && draft === null
      ? db
          .prepare('UPDATE question_sets SET draft = NULL WHERE task_id = ? AND state = ?')
          .run(taskId, QuestionSetState.Open)
      : db
          .prepare('UPDATE question_sets SET draft = ? WHERE id = ? AND task_id = ? AND state = ?')
          .run(contents, draft?.questionSetId ?? '', taskId, QuestionSetState.Open)
  return changes !== 0
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
  // The card's draft goes with the answers: nothing of it is left behind, and nothing is saved onto a closed set.
  const { changes } = db
    .prepare(`UPDATE ${TABLE} SET state = ?, reply = ?, closed_at = ?, draft = NULL WHERE id = ? AND state = ?`)
    .run(closing.state, reply, now, id, QuestionSetState.Open)
  return changes === 0 ? undefined : getQuestionSet(db, id)
}

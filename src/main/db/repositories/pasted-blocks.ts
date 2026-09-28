// The text pasted into messages, marked for the agent (migration 44, #363): each belongs to one message in the chat
// log, one waiting in the queue or a task's input draft, in the order its token appears among the typed text —
// exactly as images are kept (`./images`). A message carries just its blocks' short ids and text; the token that
// stands for a block among typed text never carries either (`shared/pastedContent.ts`).
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { EpochMs, PastedBlock } from '../../../shared/domain'
import { Row } from './rows'

/** What a pasted block can belong to. */
export enum PastedBlockOwnerKind {
  Message = 'message',
  QueuedMessage = 'queued_message',
  /** A task's input draft, by the task's id. */
  Draft = 'draft',
}

/** The message, queued message or draft a pasted block belongs to. */
export interface PastedBlockOwner {
  readonly kind: PastedBlockOwnerKind
  readonly id: string
}

/** Pasted blocks to store with a message, in the order their tokens appear among its typed text. */
export interface NewPastedBlocks {
  readonly taskId: string
  readonly owner: PastedBlockOwner
  readonly blocks: readonly PastedBlock[]
}

/** The column that names an owner of its kind. */
function ownerColumn(kind: PastedBlockOwnerKind): string {
  switch (kind) {
    case PastedBlockOwnerKind.Message:
      return 'message_id'
    case PastedBlockOwnerKind.QueuedMessage:
      return 'queued_message_id'
    case PastedBlockOwnerKind.Draft:
      return 'draft_task_id'
  }
}

function parseBlock(raw: unknown): PastedBlock {
  const row = new Row('pasted_blocks', raw)
  return { id: row.text('tag_id'), text: row.text('text') }
}

/** Stores a message's pasted blocks, in order, answering with them (as they're kept: `PastedBlock`, unchanged). */
export function addPastedBlocks(db: Database, input: NewPastedBlocks, now: EpochMs = Date.now()): PastedBlock[] {
  const insert = db.prepare(
    `INSERT INTO pasted_blocks (id, task_id, ${ownerColumn(input.owner.kind)}, position, tag_id, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  return input.blocks.map((block, position) => {
    insert.run(randomUUID(), input.taskId, input.owner.id, position, block.id, block.text, now)
    return block
  })
}

/** A message's pasted blocks, in order. */
export function pastedBlocksOf(db: Database, owner: PastedBlockOwner): PastedBlock[] {
  return db
    .prepare(`SELECT tag_id, text FROM pasted_blocks WHERE ${ownerColumn(owner.kind)} = ? ORDER BY position`)
    .all(owner.id)
    .map(parseBlock)
}

/** The pasted blocks of every message of a task of one kind, by owner id, each in order. */
export function pastedBlocksByOwner(
  db: Database,
  taskId: string,
  kind: PastedBlockOwnerKind,
): Map<string, PastedBlock[]> {
  const column = ownerColumn(kind)
  const byOwner = new Map<string, PastedBlock[]>()
  const rows = db
    .prepare(
      `SELECT tag_id, text, ${column} AS owner FROM pasted_blocks WHERE task_id = ? AND ${column} IS NOT NULL
      ORDER BY position`,
    )
    .all(taskId)
  for (const raw of rows) {
    const owner = new Row('pasted_blocks', raw).text('owner')
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), parseBlock(raw)])
  }
  return byOwner
}

/** Moves a queued message's pasted blocks to the message it was delivered as, keeping their order. */
export function moveQueuedPastedBlocks(db: Database, queuedMessageId: string, messageId: string): void {
  db.prepare('UPDATE pasted_blocks SET message_id = ?, queued_message_id = NULL WHERE queued_message_id = ?').run(
    messageId,
    queuedMessageId,
  )
}

// Each task's input draft (migration 28): what's in its input bar and not sent yet, kept so it's there again after a
// relaunch or a crash. A task has at most one, and none while its input bar is empty. The draft's pasted images are in
// `images`, and its pasted blocks in `pasted_blocks` (migration 44), each owned by the draft (by the task's id).
import type { Database } from 'better-sqlite3'
import type { EpochMs, InputDraft, PastedBlock } from '../../../shared/domain'
import type { ImageData } from '../../../shared/images'
import { addImages, ImageOwnerKind, imagesOf, type ImageOwner } from './images'
import { addPastedBlocks, PastedBlockOwnerKind, pastedBlocksOf } from './pasted-blocks'
import { Row } from './rows'

/** A change to a task's draft: its text, and its images or pasted blocks when they changed. */
export interface InputDraftChange {
  readonly taskId: string
  readonly text: string
  /** Every image in the draft, in order, in place of those it had. Left out, it keeps the ones it has. */
  readonly images?: readonly ImageData[] | undefined
  /** Every pasted block in the draft, in order, in place of those it had. Left out, it keeps the ones it has. */
  readonly pastedBlocks?: readonly PastedBlock[] | undefined
}

function draftOwner(taskId: string): ImageOwner {
  return { kind: ImageOwnerKind.Draft, id: taskId }
}

function pastedDraftOwner(taskId: string): { kind: PastedBlockOwnerKind; id: string } {
  return { kind: PastedBlockOwnerKind.Draft, id: taskId }
}

/** A task's draft, with its images' bytes and its pasted blocks; undefined when it has none. */
export function getInputDraft(db: Database, taskId: string): InputDraft | undefined {
  const row: unknown = db.prepare('SELECT text FROM input_drafts WHERE task_id = ?').get(taskId)
  if (row === undefined) return undefined
  return {
    text: new Row('input_drafts', row).text('text'),
    images: imagesOf(db, draftOwner(taskId)),
    pastedBlocks: pastedBlocksOf(db, pastedDraftOwner(taskId)),
  }
}

/**
 * Stores a task's draft as it now is, replacing the one it had. A draft with no text, no images and no pasted blocks
 * is none: it's removed. Does nothing for a task that isn't there (any more), answering false: a deleted task's input
 * bar can save as it closes.
 */
export function setInputDraft(db: Database, change: InputDraftChange, now: EpochMs = Date.now()): boolean {
  const { taskId, text, images, pastedBlocks } = change
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) === undefined) return false
    const imageCount =
      images?.length ??
      (db.prepare('SELECT COUNT(*) FROM images WHERE draft_task_id = ?').pluck().get(taskId) as number)
    const pastedBlockCount =
      pastedBlocks?.length ??
      (db.prepare('SELECT COUNT(*) FROM pasted_blocks WHERE draft_task_id = ?').pluck().get(taskId) as number)
    if (text === '' && imageCount === 0 && pastedBlockCount === 0) {
      // Its images and pasted blocks go with it.
      db.prepare('DELETE FROM input_drafts WHERE task_id = ?').run(taskId)
      return true
    }
    db.prepare(
      `INSERT INTO input_drafts (task_id, text, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (task_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    ).run(taskId, text, now)
    if (images !== undefined) {
      db.prepare('DELETE FROM images WHERE draft_task_id = ?').run(taskId)
      addImages(db, { taskId, owner: draftOwner(taskId), images }, now)
    }
    if (pastedBlocks !== undefined) {
      db.prepare('DELETE FROM pasted_blocks WHERE draft_task_id = ?').run(taskId)
      addPastedBlocks(db, { taskId, owner: pastedDraftOwner(taskId), blocks: pastedBlocks }, now)
    }
    return true
  })()
}

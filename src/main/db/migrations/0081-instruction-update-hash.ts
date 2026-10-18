import type { Database } from 'better-sqlite3'
import type { Migration } from '../migrate'
import { hashLines } from '../../agent/instruction-hash'
import { INSTRUCTION_UPDATES, TODO_TOOLS_LINE } from '../../agent/system-prompt'
import { Row } from '../repositories/rows'

/**
 * The wording `TODO_TOOLS_LINE` had before #680 added its last sentence (`waiting`), kept here only so this
 * migration can tell a session that saw that wording from one that saw the current one.
 */
export const TODO_TOOLS_LINE_BEFORE_680 =
  "Keep this task's todos with create_todo, update_todo and list_todos: there is no TaskCreate, TaskUpdate, " +
  "TaskList, TaskGet or TodoWrite here any more. A note on a todo (what it is for, or where it stands) shows " +
  "while it isn't done, not only while you're doing it."

/**
 * Adds `session_context.instruction_update_hash` (#708): a fingerprint of the first `instruction_updates` lines of
 * `INSTRUCTION_UPDATES`, as their text stood when a session was last sent them. Without it, a session already
 * counted as having a line never learns that the line's wording changed (#680 edited `TODO_TOOLS_LINE` in place,
 * instead of appending a new one, so sessions that had already reached it stayed on its old wording forever: "oh
 * nooooo tasks don't see mcp updates until they restart!!", Jared, Oct 18).
 *
 * Backfilling it needs the wording each row actually saw, not today's: a row whose `instruction_updates` had
 * already passed `TODO_TOOLS_LINE`'s position saw #680's old wording there, whatever it's since caught up to past
 * it (catching up to a later line never revisits one already counted as seen). So its prefix is built with that old
 * wording standing in for the current one, and every other line as it reads now (none of the others have changed
 * text since sessions started recording this). That one line's current wording won't match, so it's resent once.
 *
 * A row whose `instruction_updates` hadn't reached `TODO_TOOLS_LINE` yet needs no substitution: it gets the current
 * wording fresh, through the ordinary "new line" path, once it catches up. The same rule also covers a row that
 * jumped straight past that position after #680 already shipped (its current wording was all it ever saw there) —
 * this backfill can't tell that case apart from a genuinely stale one, so it treats both alike. The cost is a
 * session already correct getting told once more, which a fresh session on 0.35.0 may see too; see the PR.
 */
export const instructionUpdateHashMigration: Migration = {
  version: 81,
  name: 'Add the fingerprint of the instruction updates a session has',
  up(db: Database) {
    db.exec("ALTER TABLE session_context ADD COLUMN instruction_update_hash TEXT NOT NULL DEFAULT ''")

    const toolsLineIndex = INSTRUCTION_UPDATES.indexOf(TODO_TOOLS_LINE)
    const rows = db
      .prepare('SELECT task_id, instruction_updates FROM session_context')
      .all()
      .map((raw) => {
        const row = new Row('session_context', raw)
        return { taskId: row.text('task_id'), instructionUpdates: row.integer('instruction_updates') }
      })
    const update = db.prepare('UPDATE session_context SET instruction_update_hash = @hash WHERE task_id = @taskId')
    for (const { taskId, instructionUpdates } of rows) {
      const prefix = INSTRUCTION_UPDATES.slice(0, instructionUpdates)
      const historical =
        toolsLineIndex >= 0 && instructionUpdates > toolsLineIndex
          ? prefix.map((line, index) => (index === toolsLineIndex ? TODO_TOOLS_LINE_BEFORE_680 : line))
          : prefix
      update.run({ hash: hashLines(historical), taskId })
    }
  },
}

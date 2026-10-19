import { expect, it } from 'vitest'
import { hashLines } from '../../agent/instruction-hash'
import { missingContext, MissingContextKind } from '../../agent/session-context'
import { INSTRUCTION_UPDATES, TODO_TOOLS_LINE } from '../../agent/system-prompt'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSessionContext } from '../repositories/session-context'
import { MIGRATIONS } from '.'
import { instructionUpdateHashMigration, TODO_TOOLS_LINE_BEFORE_680 } from './0081-instruction-update-hash'

/** `TODO_TOOLS_LINE`'s position in `INSTRUCTION_UPDATES`: the one line #680 edited in place (#708). */
const TOOLS_LINE_INDEX = INSTRUCTION_UPDATES.indexOf(TODO_TOOLS_LINE)

function seed(db: ReturnType<typeof openDatabase>, taskId: string, instructionUpdates: number): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, ?)`,
  ).run(taskId, `session-${taskId}`)
  db.prepare(
    'INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at) VALUES (?, 1, ?, NULL)',
  ).run(taskId, instructionUpdates)
}

it('is migration 81, after every earlier one', () => {
  expect(instructionUpdateHashMigration.version).toBe(81)
  expect(MIGRATIONS.indexOf(instructionUpdateHashMigration)).toBe(MIGRATIONS.filter((m) => m.version < 81).length)
})

it("backfills a row that never reached TODO_TOOLS_LINE with today's wording: nothing was stale to begin with", () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 81),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  seed(db, 't', TOOLS_LINE_INDEX)

  migrate(db, MIGRATIONS)

  expect(getSessionContext(db, 't')?.instructionUpdateHash).toBe(
    hashLines(INSTRUCTION_UPDATES.slice(0, TOOLS_LINE_INDEX)),
  )
  const recorded = getSessionContext(db, 't')
  // Nothing was stale: catching up to TODO_TOOLS_LINE later gets today's wording through the ordinary "new line" path.
  // (The row also owes the todo hub's lines, #501: nothing here set it, as this migration doesn't touch it.)
  expect(
    missingContext({
      recorded,
      startedElsewhere: false,
      handoff: null,
      externalId: null,
      prompt: '',
      sandboxed: false,
    }),
  ).toEqual([
    { kind: MissingContextKind.Updates, updates: INSTRUCTION_UPDATES.slice(TOOLS_LINE_INDEX) },
    { kind: MissingContextKind.TodoHub },
  ])
  db.close()
})

it('backfills a row already past TODO_TOOLS_LINE with the wording it actually saw, so the fix sends it once', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 81),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  seed(db, 'caught-up', INSTRUCTION_UPDATES.length)
  seed(db, 'partway', TOOLS_LINE_INDEX + 1)

  migrate(db, MIGRATIONS)

  // Each gets the old wording standing in for TODO_TOOLS_LINE, but only up to as many lines as it was counted as
  // having: "caught up" already counted every line, "partway" only up to (and including) TODO_TOOLS_LINE's own.
  const substitute = (line: string, index: number): string =>
    index === TOOLS_LINE_INDEX ? TODO_TOOLS_LINE_BEFORE_680 : line
  expect(getSessionContext(db, 'caught-up')?.instructionUpdateHash).toBe(hashLines(INSTRUCTION_UPDATES.map(substitute)))
  expect(getSessionContext(db, 'partway')?.instructionUpdateHash).toBe(
    hashLines(INSTRUCTION_UPDATES.slice(0, TOOLS_LINE_INDEX + 1).map(substitute)),
  )

  // Neither matches TODO_TOOLS_LINE's current wording any more, so both are told the whole list once, not just the
  // one line that changed (#708): simpler than tracking which line, and harmless for the ones that hadn't changed.
  for (const taskId of ['caught-up', 'partway']) {
    const recorded = getSessionContext(db, taskId)
    expect(
      missingContext({
        recorded,
        startedElsewhere: false,
        handoff: null,
        externalId: null,
        prompt: '',
        sandboxed: false,
      }),
    ).toEqual([
      { kind: MissingContextKind.Updates, updates: INSTRUCTION_UPDATES },
      { kind: MissingContextKind.TodoHub },
    ])
  }
  db.close()
})

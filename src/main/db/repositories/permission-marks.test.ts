import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionMarkKind, type PermissionMarkOutcome, type Task } from '../../../shared/domain'
import { FolderAccess, SandboxAskKind, SandboxGrantScope } from '../../../shared/sandbox'
import { getPermissionMark, listPermissionMarks, setPermissionMark } from './permission-marks'
import { RowError } from './rows'
import { deleteTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

const WEB = { kind: SandboxAskKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.Read } as const
const GRANT: PermissionMarkOutcome = { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: WEB }
const RULE: PermissionMarkOutcome = {
  kind: PermissionMarkKind.TaskRule,
  rule: { toolName: 'Bash', ruleContent: 'npm run lint *' },
}
const BLOCKED: PermissionMarkOutcome = { kind: PermissionMarkKind.Blocked, ask: null }

describe('permission marks', () => {
  it('keeps one mark per call, each outcome read back as it was, in the order the calls were first marked', () => {
    const domain: PermissionMarkOutcome = {
      kind: PermissionMarkKind.Grant,
      scope: SandboxGrantScope.Glade,
      ask: { kind: SandboxAskKind.Domain, domain: 'docs.acme.dev', command: null, commandDescription: null },
    }
    expect(setPermissionMark(test.db, { taskId: task.id, toolUseId: 'a', outcome: GRANT }, 10)).toEqual({
      taskId: task.id,
      toolUseId: 'a',
      outcome: GRANT,
      createdAt: 10,
    })
    setPermissionMark(test.db, { taskId: task.id, toolUseId: 'b', outcome: RULE }, 20)
    setPermissionMark(test.db, { taskId: task.id, toolUseId: 'c', outcome: domain }, 30)

    expect(listPermissionMarks(test.db, task.id).map(({ toolUseId, outcome }) => [toolUseId, outcome])).toEqual([
      ['a', GRANT],
      ['b', RULE],
      ['c', domain],
    ])
    expect(getPermissionMark(test.db, task.id, 'missing')).toBeUndefined()
  })

  it('says nothing changed when a call is marked the same again, and replaces its outcome with another', () => {
    setPermissionMark(test.db, { taskId: task.id, toolUseId: 'a', outcome: BLOCKED }, 10)

    expect(setPermissionMark(test.db, { taskId: task.id, toolUseId: 'a', outcome: BLOCKED }, 20)).toBeUndefined()
    const named: PermissionMarkOutcome = { kind: PermissionMarkKind.Blocked, ask: WEB }
    // It keeps when it was first marked, so its place among the marks.
    expect(setPermissionMark(test.db, { taskId: task.id, toolUseId: 'a', outcome: named }, 30)).toEqual({
      taskId: task.id,
      toolUseId: 'a',
      outcome: named,
      createdAt: 10,
    })
    expect(listPermissionMarks(test.db, task.id)).toHaveLength(1)
  })

  it('goes with its task, and refuses a row whose outcome is not one it knows', () => {
    setPermissionMark(test.db, { taskId: task.id, toolUseId: 'a', outcome: GRANT })
    test.db.prepare(`UPDATE permission_marks SET outcome = '{"kind":"moon"}'`).run()
    expect(() => listPermissionMarks(test.db, task.id)).toThrow(RowError)
    expect(() => test.db.prepare(`UPDATE permission_marks SET outcome = '[]'`).run()).toThrow(/CHECK/)

    deleteTask(test.db, task.id)
    expect(test.db.prepare('SELECT COUNT(*) FROM permission_marks').pluck().get()).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import { deleteTask } from './tasks'
import { addTaskPermissionRule, listTaskPermissionRules } from './task-permission-rules'
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

const NPM_TEST = { toolName: 'Bash', ruleContent: 'npm test *' }
const EDIT = { toolName: 'Edit' }

describe('task permission rules', () => {
  it('grants a task rules and lists them in the order they were first granted', () => {
    expect(listTaskPermissionRules(test.db, task.id)).toEqual([])

    expect(addTaskPermissionRule(test.db, { taskId: task.id, rule: NPM_TEST }, 2)).toBe(true)
    expect(addTaskPermissionRule(test.db, { taskId: task.id, rule: EDIT }, 1)).toBe(true)

    expect(listTaskPermissionRules(test.db, task.id)).toEqual([
      { taskId: task.id, rule: EDIT, createdAt: 1 },
      { taskId: task.id, rule: NPM_TEST, createdAt: 2 },
    ])
  })

  it('keeps one row for a rule granted twice, as it was first granted', () => {
    addTaskPermissionRule(test.db, { taskId: task.id, rule: NPM_TEST }, 1)
    expect(addTaskPermissionRule(test.db, { taskId: task.id, rule: { ...NPM_TEST } }, 5)).toBe(false)
    addTaskPermissionRule(test.db, { taskId: task.id, rule: EDIT }, 2)
    // No content and empty content are the same rule: the whole tool.
    expect(addTaskPermissionRule(test.db, { taskId: task.id, rule: { toolName: 'Edit', ruleContent: '' } }, 6)).toBe(
      false,
    )

    expect(listTaskPermissionRules(test.db, task.id)).toEqual([
      { taskId: task.id, rule: NPM_TEST, createdAt: 1 },
      { taskId: task.id, rule: EDIT, createdAt: 2 },
    ])
  })

  it('tells apart rules that differ in their tool, their content, or only by a prefix of it', () => {
    const rules = [
      NPM_TEST,
      { toolName: 'Bash', ruleContent: 'npm test' },
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Bash', ruleContent: 'npm testing *' },
      EDIT,
      { toolName: 'Write' },
      { toolName: 'Edit', ruleContent: 'src/**' },
    ]
    for (const [index, rule] of rules.entries()) {
      expect(addTaskPermissionRule(test.db, { taskId: task.id, rule }, index)).toBe(true)
    }

    expect(listTaskPermissionRules(test.db, task.id).map(({ rule }) => rule)).toEqual(rules)
  })

  it('keeps many rules, in order', () => {
    const rules = Array.from({ length: 500 }, (_, index) => ({
      toolName: 'Bash',
      ruleContent: `make target-${String(index)} *`,
    }))
    for (const rule of rules) addTaskPermissionRule(test.db, { taskId: task.id, rule }, 1)

    expect(listTaskPermissionRules(test.db, task.id).map(({ rule }) => rule)).toEqual(rules)
  })

  it("keeps each task's rules its own, and deletes a task's with it", () => {
    const other = sampleTask(test.db, task.workspaceId)
    addTaskPermissionRule(test.db, { taskId: task.id, rule: NPM_TEST }, 1)
    addTaskPermissionRule(test.db, { taskId: other.id, rule: EDIT }, 1)
    // The same rule for both tasks is two grants.
    expect(addTaskPermissionRule(test.db, { taskId: other.id, rule: NPM_TEST }, 2)).toBe(true)

    expect(listTaskPermissionRules(test.db, task.id).map(({ rule }) => rule)).toEqual([NPM_TEST])
    expect(listTaskPermissionRules(test.db, other.id).map(({ rule }) => rule)).toEqual([EDIT, NPM_TEST])

    deleteTask(test.db, task.id)
    expect(listTaskPermissionRules(test.db, task.id)).toEqual([])
    expect(listTaskPermissionRules(test.db, other.id)).toHaveLength(2)
    expect(test.db.prepare('SELECT COUNT(*) FROM task_permission_rules').pluck().get()).toBe(2)
  })

  it('refuses a rule for a task that does not exist, or without a tool', () => {
    expect(() => addTaskPermissionRule(test.db, { taskId: 'missing', rule: EDIT })).toThrow(/FOREIGN KEY/)
    expect(() => addTaskPermissionRule(test.db, { taskId: task.id, rule: { toolName: '' } })).toThrow(/CHECK/)
    expect(listTaskPermissionRules(test.db, task.id)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { PauseReason } from '../../shared/domain'
import {
  EMPTY_MENU_BAR_SNAPSHOT,
  NeedsYouReason,
  type MenuBarSnapshot,
  type NeedsYouItem,
  type SentNotification,
  type WorkingItem,
} from '../../shared/menuBar'
import { TaskIndicator } from '../../shared/taskIndicator'
import { MenuBarSectionKind, menuBarSections, WORKING_STATUS } from './menuBarModel'

const MINUTE = 60_000
const NOW = 10 * 60 * MINUTE

function needs(taskId: string, reason: NeedsYouReason, workspaceName = 'Acme API'): NeedsYouItem {
  return { taskId, title: `Task ${taskId}`, workspaceId: workspaceName, workspaceName, reason, since: 1_000 }
}

function working(taskId: string, overrides: Partial<WorkingItem> = {}): WorkingItem {
  return {
    taskId,
    title: `Task ${taskId}`,
    workspaceId: 'w1',
    workspaceName: 'Acme API',
    status: 'Running the tests',
    todos: null,
    pause: null,
    startedAt: NOW - 12 * MINUTE - 40_000,
    ...overrides,
  }
}

function sent(seq: number, minutesAgo: number): SentNotification {
  return {
    seq,
    taskId: `t${String(seq)}`,
    title: `Task ${String(seq)}`,
    body: 'Which limit?',
    sentAt: NOW - minutesAgo * MINUTE,
  }
}

function snapshot(overrides: Partial<MenuBarSnapshot>): MenuBarSnapshot {
  return { ...EMPTY_MENU_BAR_SNAPSHOT, ...overrides }
}

describe('menuBarSections', () => {
  it('has no sections with nothing in flight', () => {
    expect(menuBarSections(EMPTY_MENU_BAR_SNAPSHOT, NOW)).toEqual([])
  })

  it('lists Needs you, Working and Recent in that order, leaving out each one with nothing in it', () => {
    const all = snapshot({
      needsYou: [needs('a', NeedsYouReason.Reply)],
      working: [working('b')],
      recent: [sent(1, 2)],
    })
    expect(menuBarSections(all, NOW).map(({ kind }) => kind)).toEqual([
      MenuBarSectionKind.NeedsYou,
      MenuBarSectionKind.Working,
      MenuBarSectionKind.Recent,
    ])
    expect(menuBarSections({ ...all, needsYou: [] }, NOW).map(({ kind }) => kind)).toEqual([
      MenuBarSectionKind.Working,
      MenuBarSectionKind.Recent,
    ])
    expect(menuBarSections({ ...all, working: [] }, NOW).map(({ kind }) => kind)).toEqual([
      MenuBarSectionKind.NeedsYou,
      MenuBarSectionKind.Recent,
    ])
    expect(menuBarSections({ ...all, recent: [] }, NOW).map(({ kind }) => kind)).toEqual([
      MenuBarSectionKind.NeedsYou,
      MenuBarSectionKind.Working,
    ])
  })

  it('says why each task needs you, and where, pink for an error and purple otherwise, in the order given', () => {
    const [section] = menuBarSections(
      snapshot({
        needsYou: [
          needs('a', NeedsYouReason.Asking),
          needs('b', NeedsYouReason.Permission, 'Billing'),
          needs('c', NeedsYouReason.Reply),
          needs('d', NeedsYouReason.Error, 'Billing'),
        ],
      }),
      NOW,
    )
    expect(section).toEqual({
      kind: MenuBarSectionKind.NeedsYou,
      rows: [
        {
          taskId: 'a',
          title: 'Task a',
          workspaceName: 'Acme API',
          reason: 'Asking a question',
          indicator: TaskIndicator.Waiting,
        },
        {
          taskId: 'b',
          title: 'Task b',
          workspaceName: 'Billing',
          reason: 'Waiting for permission',
          indicator: TaskIndicator.Waiting,
        },
        {
          taskId: 'c',
          title: 'Task c',
          workspaceName: 'Acme API',
          reason: 'Reply waiting',
          indicator: TaskIndicator.Waiting,
        },
        {
          taskId: 'd',
          title: 'Task d',
          workspaceName: 'Billing',
          reason: 'Stopped on an error',
          indicator: TaskIndicator.Error,
        },
      ],
    })
  })

  it('shows a working task’s status, todo progress and how long its turn has run', () => {
    const todos = { done: 3, total: 7, doing: ['Run the tests'] }
    const [section] = menuBarSections(snapshot({ working: [working('a', { todos })] }), NOW)
    expect(section).toEqual({
      kind: MenuBarSectionKind.Working,
      rows: [{ taskId: 'a', title: 'Task a', status: 'Running the tests', todos, progress: 3 / 7, elapsed: '12m 40s' }],
    })
  })

  it('shows progress from none done to all done, and no bar without a list', () => {
    const progress = [{ done: 0, total: 4, doing: [] }, { done: 4, total: 4, doing: [] }, null].map((todos) => {
      const [section] = menuBarSections(snapshot({ working: [working('a', { todos })] }), NOW)
      return section?.kind === MenuBarSectionKind.Working ? section.rows[0]?.progress : undefined
    })
    expect(progress).toEqual([0, 1, null])
  })

  it('says a task with no status yet is working, and one that is paused why and until when', () => {
    const pause = {
      reason: PauseReason.UsageLimit,
      since: NOW - MINUTE,
      resumesAt: NOW + 30 * MINUTE,
      checks: 0,
      details: '',
    }
    const [section] = menuBarSections(
      snapshot({ working: [working('new', { status: '' }), working('paused', { pause })] }),
      NOW,
    )
    const statuses = section?.kind === MenuBarSectionKind.Working ? section.rows.map(({ status }) => status) : []
    expect(statuses[0]).toBe(WORKING_STATUS)
    expect(statuses[1]).toMatch(/^Paused: usage limit/)
  })

  it('counts elapsed time in seconds, then minutes, then hours, never below nothing, and not at all when unknown', () => {
    const elapsed = [NOW - 42_000, NOW - 65 * MINUTE, NOW + 5_000, null].map((startedAt) => {
      const [section] = menuBarSections(snapshot({ working: [working('a', { startedAt })] }), NOW)
      return section?.kind === MenuBarSectionKind.Working ? section.rows[0]?.elapsed : undefined
    })
    expect(elapsed).toEqual(['42s', '1h 05m', '0s', null])
  })

  it('shows each notification with how long ago it was sent', () => {
    const [section] = menuBarSections(snapshot({ recent: [sent(3, 0), sent(2, 9), sent(1, 65)] }), NOW)
    expect(section).toEqual({
      kind: MenuBarSectionKind.Recent,
      rows: [
        { key: 3, taskId: 't3', title: 'Task 3', body: 'Which limit?', age: 'just now' },
        { key: 2, taskId: 't2', title: 'Task 2', body: 'Which limit?', age: '9m ago' },
        { key: 1, taskId: 't1', title: 'Task 1', body: 'Which limit?', age: '1h 5m ago' },
      ],
    })
  })
})

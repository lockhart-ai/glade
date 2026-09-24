import { describe, expect, it } from 'vitest'
import { TaskState, UiStateKey, type Task } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  collapsedValue,
  collapseKey,
  isCollapsed,
  SectionId,
  sectionTasks,
  Step,
  stepSelection,
  visibleTaskIds,
} from './sections'

function task(id: string, updatedAt: number, change: Partial<Task> = {}): Task {
  return { ...sampleTask(id, 'w1', id), updatedAt, ...change }
}

function ids(tasks: readonly Task[]): string[] {
  return tasks.map(({ id }) => id)
}

describe('sectionTasks', () => {
  it('splits tasks into Pinned, Active and Done, most recently updated first', () => {
    const tasks = [
      task('old-active', 100),
      task('new-active', 300),
      task('done', 200, { state: TaskState.Done }),
      task('pinned-done', 50, { state: TaskState.Done, pinned: true }),
      task('pinned-active', 400, { pinned: true }),
      task('older-done', 10, { state: TaskState.Done }),
    ]

    const sections = sectionTasks(tasks, 'w1')

    expect(sections.map(({ id, tasks: sectioned }) => [id, ids(sectioned)])).toEqual([
      [SectionId.Pinned, ['pinned-active', 'pinned-done']],
      [SectionId.Active, ['new-active', 'old-active']],
      [SectionId.Done, ['done', 'older-done']],
    ])
  })

  it('leaves out other workspaces’ tasks', () => {
    const sections = sectionTasks([task('mine', 1), { ...task('theirs', 2), workspaceId: 'w2' }], 'w1')

    expect(sections.flatMap(({ tasks }) => ids(tasks))).toEqual(['mine'])
  })

  it('orders tasks updated at the same time by id', () => {
    const sections = sectionTasks([task('b', 5), task('a', 5)], 'w1')

    expect(ids(sections[1]?.tasks ?? [])).toEqual(['a', 'b'])
  })

  it('has every section even when empty', () => {
    expect(sectionTasks([], 'w1')).toEqual([
      { id: SectionId.Pinned, tasks: [] },
      { id: SectionId.Active, tasks: [] },
      { id: SectionId.Done, tasks: [] },
    ])
  })
})

describe('collapse state', () => {
  it('starts with Pinned and Active expanded and Done collapsed', () => {
    expect(isCollapsed({}, SectionId.Pinned)).toBe(false)
    expect(isCollapsed({}, SectionId.Active)).toBe(false)
    expect(isCollapsed({}, SectionId.Done)).toBe(true)
  })

  it('reads each section’s stored value', () => {
    const uiState = {
      [UiStateKey.PinnedSectionCollapsed]: 'true',
      [UiStateKey.ActiveSectionCollapsed]: 'true',
      [UiStateKey.DoneSectionCollapsed]: 'false',
    }

    expect(isCollapsed(uiState, SectionId.Pinned)).toBe(true)
    expect(isCollapsed(uiState, SectionId.Active)).toBe(true)
    expect(isCollapsed(uiState, SectionId.Done)).toBe(false)
  })

  it('stores each section under its own key, as true or false', () => {
    expect([SectionId.Pinned, SectionId.Active, SectionId.Done].map(collapseKey)).toEqual([
      UiStateKey.PinnedSectionCollapsed,
      UiStateKey.ActiveSectionCollapsed,
      UiStateKey.DoneSectionCollapsed,
    ])
    expect(collapsedValue(true)).toBe('true')
    expect(collapsedValue(false)).toBe('false')
  })
})

describe('visibleTaskIds', () => {
  const sections = sectionTasks(
    [task('p', 1, { pinned: true }), task('a1', 3), task('a2', 2), task('d', 1, { state: TaskState.Done })],
    'w1',
  )

  it('lists the tasks top to bottom, skipping collapsed sections', () => {
    expect(visibleTaskIds(sections, {})).toEqual(['p', 'a1', 'a2'])
    expect(
      visibleTaskIds(sections, {
        [UiStateKey.ActiveSectionCollapsed]: 'true',
        [UiStateKey.DoneSectionCollapsed]: 'false',
      }),
    ).toEqual(['p', 'd'])
  })
})

describe('stepSelection', () => {
  const order = ['a', 'b', 'c']

  it('moves to the next or previous task', () => {
    expect(stepSelection(order, 'b', Step.Next)).toBe('c')
    expect(stepSelection(order, 'b', Step.Previous)).toBe('a')
  })

  it('stays put at either end', () => {
    expect(stepSelection(order, 'c', Step.Next)).toBe('c')
    expect(stepSelection(order, 'a', Step.Previous)).toBe('a')
  })

  it('starts from the top or bottom with nothing, or a hidden task, selected', () => {
    expect(stepSelection(order, null, Step.Next)).toBe('a')
    expect(stepSelection(order, null, Step.Previous)).toBe('c')
    expect(stepSelection(order, 'hidden', Step.Next)).toBe('a')
  })

  it('selects nothing when there are no tasks', () => {
    expect(stepSelection([], 'a', Step.Next)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { TodoState, type Todo } from '../../shared/domain'
import { CHILD_KINDS, ChildFilter, ChildKind, type Child, type TodoPanel } from '../../shared/todoHub'
import {
  filterChildren,
  filterOfKind,
  kindCountLabel,
  kindCounts,
  kindLabel,
  panelView,
  sameChildren,
  samePanel,
  sameTodo,
  shownFilter,
  tileLabel,
} from './todoHubModel'

function child(kind: ChildKind, key: string, live = false): Child {
  return { kind, key, updatedAt: 1_000, live, source: null }
}

const CHILDREN: readonly Child[] = [
  child(ChildKind.Subagent, 'agent-b', true),
  child(ChildKind.Watcher, 'watch-a'),
  child(ChildKind.Subagent, 'agent-a'),
  child(ChildKind.Link, 'https://github.com/acme/api/pull/511'),
  child(ChildKind.Commit, 'abc /code/api'),
  child(ChildKind.Commit, 'def /code/api'),
]

describe('kindCounts', () => {
  it('counts each kind in the row’s order (files, links, subagents, watchers, changes), leaving out a kind with none', () => {
    expect(kindCounts(CHILDREN)).toEqual([
      { kind: ChildKind.Link, count: 1, live: 0 },
      { kind: ChildKind.Subagent, count: 2, live: 1 },
      { kind: ChildKind.Watcher, count: 1, live: 0 },
      { kind: ChildKind.Commit, count: 2, live: 0 },
    ])
  })

  it('is empty for a todo with nothing under it, and one entry for a todo with one kind only', () => {
    expect(kindCounts([])).toEqual([])
    expect(kindCounts([child(ChildKind.File, 'a.md'), child(ChildKind.File, 'b.md')])).toEqual([
      { kind: ChildKind.File, count: 2, live: 0 },
    ])
  })

  it('counts every live one of a kind', () => {
    const watchers = [child(ChildKind.Watcher, 'a', true), child(ChildKind.Watcher, 'b', true)]
    expect(kindCounts(watchers)).toEqual([{ kind: ChildKind.Watcher, count: 2, live: 2 }])
  })
})

describe('what a count says in words', () => {
  it('names one or several of each kind, a commit as a change', () => {
    const said = (kind: ChildKind, count: number): string => kindCountLabel({ kind, count, live: 0 })
    expect(CHILD_KINDS.map((kind) => said(kind, 1))).toEqual([
      '1 file',
      '1 link',
      '1 subagent',
      '1 watcher',
      '1 change',
    ])
    expect(CHILD_KINDS.map((kind) => said(kind, 3))).toEqual([
      '3 files',
      '3 links',
      '3 subagents',
      '3 watchers',
      '3 changes',
    ])
  })

  it('says how many are running, for a kind with something live', () => {
    expect(kindCountLabel({ kind: ChildKind.Subagent, count: 2, live: 1 })).toBe('2 subagents, 1 running')
    expect(kindCountLabel({ kind: ChildKind.Watcher, count: 1, live: 1 })).toBe('1 watcher, 1 running')
  })

  it('names a tile by its kind and its title', () => {
    expect(CHILD_KINDS.map(kindLabel)).toEqual(['File', 'Link', 'Subagent', 'Watcher', 'Change'])
    expect(tileLabel(ChildKind.Subagent, 'fix-501-ci')).toBe('Subagent: fix-501-ci')
  })
})

describe('an open todo’s filter', () => {
  it('has one filter per kind', () => {
    expect(CHILD_KINDS.map(filterOfKind)).toEqual([
      ChildFilter.Files,
      ChildFilter.Links,
      ChildFilter.Subagents,
      ChildFilter.Watchers,
      ChildFilter.Commits,
    ])
  })

  it('shows the one it remembers while that kind has children, and All once it has none', () => {
    const counts = kindCounts(CHILDREN)
    expect(shownFilter(counts, ChildFilter.Subagents)).toBe(ChildFilter.Subagents)
    expect(shownFilter(counts, ChildFilter.All)).toBe(ChildFilter.All)
    // No files under this todo.
    expect(shownFilter(counts, ChildFilter.Files)).toBe(ChildFilter.All)
    expect(shownFilter([], ChildFilter.Watchers)).toBe(ChildFilter.All)
  })

  it('shows every child under All, in the order they came, and one kind’s under its filter', () => {
    expect(filterChildren(CHILDREN, ChildFilter.All)).toBe(CHILDREN)
    expect(filterChildren(CHILDREN, ChildFilter.Subagents).map(({ key }) => key)).toEqual(['agent-b', 'agent-a'])
    expect(filterChildren(CHILDREN, ChildFilter.Files)).toEqual([])
  })
})

describe('telling whether a card changed', () => {
  it('counts lists made anew as the same while they hold the same children, in the same order, as live as before', () => {
    const again = CHILDREN.map((each) => ({ ...each, updatedAt: each.updatedAt + 5 }))
    expect(sameChildren(CHILDREN, CHILDREN)).toBe(true)
    expect(sameChildren(CHILDREN, again)).toBe(true)
    expect(sameChildren([], [])).toBe(true)
  })

  it('tells a child added, removed, moved in the order, of another kind, or gone live', () => {
    const [first, second, ...rest] = CHILDREN as [Child, Child, ...Child[]]
    expect(sameChildren(CHILDREN, [...CHILDREN, child(ChildKind.File, 'a.md')])).toBe(false)
    expect(sameChildren(CHILDREN, CHILDREN.slice(1))).toBe(false)
    expect(sameChildren(CHILDREN, [second, first, ...rest])).toBe(false)
    expect(sameChildren(CHILDREN, [{ ...first, kind: ChildKind.Watcher }, second, ...rest])).toBe(false)
    expect(sameChildren(CHILDREN, [{ ...first, key: 'agent-c' }, second, ...rest])).toBe(false)
    expect(sameChildren(CHILDREN, [{ ...first, live: false }, second, ...rest])).toBe(false)
  })

  it('counts a todo made anew as the same while it reads the same', () => {
    const todo: Todo = { id: '4', text: 'Copy the files', state: TodoState.Doing, note: 'Copying', completedAt: null }
    expect(sameTodo(todo, todo)).toBe(true)
    expect(sameTodo(todo, { ...todo })).toBe(true)
    expect(sameTodo(todo, { ...todo, id: '5' })).toBe(false)
    expect(sameTodo(todo, { ...todo, text: 'Copy all the files' })).toBe(false)
    expect(sameTodo(todo, { ...todo, note: 'Copying · 12 of 40' })).toBe(false)
    expect(sameTodo(todo, { ...todo, state: TodoState.Done })).toBe(false)
    expect(sameTodo(todo, { ...todo, completedAt: 5 })).toBe(false)
  })

  it('shows a todo you never opened as closed on All, the same as one you closed again', () => {
    const closed: TodoPanel = { taskId: 't1', todoId: '4', open: false, filter: ChildFilter.All }
    expect(panelView(undefined)).toEqual({ open: false, filter: ChildFilter.All })
    expect(panelView(closed)).toBe(closed)
    expect(samePanel(undefined, closed)).toBe(true)
    expect(samePanel(undefined, undefined)).toBe(true)
    expect(samePanel(closed, { ...closed, open: true })).toBe(false)
    expect(samePanel(closed, { ...closed, filter: ChildFilter.Links })).toBe(false)
  })
})

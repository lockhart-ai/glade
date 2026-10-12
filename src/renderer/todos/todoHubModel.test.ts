import { describe, expect, it } from 'vitest'
import { TodoState, type Todo } from '../../shared/domain'
import {
  ChildFilter,
  ChildKind,
  PRODUCED_KINDS,
  type Child,
  type ProducedKind,
  type TodoPanel,
} from '../../shared/todoHub'
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

function child(kind: ProducedKind, key: string): Child {
  return { kind, key, updatedAt: 1_000, source: null }
}

const CHILDREN: readonly Child[] = [
  child(ChildKind.Commit, 'abc /code/api'),
  child(ChildKind.Link, 'https://github.com/acme/api/pull/511'),
  child(ChildKind.Commit, 'def /code/api'),
  child(ChildKind.Link, 'https://github.com/acme/api/issues/501'),
  child(ChildKind.Commit, 'fed /code/api'),
]

describe('kindCounts', () => {
  it('counts each kind in the row’s order (files, links, changes), leaving out a kind with none', () => {
    expect(kindCounts(CHILDREN)).toEqual([
      { kind: ChildKind.Link, count: 2 },
      { kind: ChildKind.Commit, count: 3 },
    ])
    expect(kindCounts([...CHILDREN, child(ChildKind.File, 'a.md')]).map(({ kind }) => kind)).toEqual(PRODUCED_KINDS)
  })

  it('is empty for a todo with nothing under it, and one entry for a todo with one kind only', () => {
    expect(kindCounts([])).toEqual([])
    expect(kindCounts([child(ChildKind.File, 'a.md'), child(ChildKind.File, 'b.md')])).toEqual([
      { kind: ChildKind.File, count: 2 },
    ])
  })

  it('counts fifty of a kind among a hundred and fifty children', () => {
    const many = Array.from({ length: 150 }, (_, index) =>
      child(PRODUCED_KINDS[index % 3] ?? ChildKind.File, `child-${String(index)}`),
    )
    expect(kindCounts(many)).toEqual(PRODUCED_KINDS.map((kind) => ({ kind, count: 50 })))
  })
})

describe('what a count says in words', () => {
  it('names one or several of each kind, a commit as a change, and never says anything is running', () => {
    const said = (kind: ProducedKind, count: number): string => kindCountLabel({ kind, count })
    expect(PRODUCED_KINDS.map((kind) => said(kind, 1))).toEqual(['1 file', '1 link', '1 change'])
    expect(PRODUCED_KINDS.map((kind) => said(kind, 3))).toEqual(['3 files', '3 links', '3 changes'])
  })

  it('names a tile by its kind and its title', () => {
    expect(PRODUCED_KINDS.map(kindLabel)).toEqual(['File', 'Link', 'Change'])
    expect(tileLabel(ChildKind.Commit, 'Return Retry-After on 429s')).toBe('Change: Return Retry-After on 429s')
  })
})

describe('an open todo’s filter', () => {
  it('has one filter per kind a todo shows', () => {
    expect(PRODUCED_KINDS.map(filterOfKind)).toEqual([ChildFilter.Files, ChildFilter.Links, ChildFilter.Commits])
  })

  it('shows the one it remembers while that kind has children, and All once it has none', () => {
    const counts = kindCounts(CHILDREN)
    expect(shownFilter(counts, ChildFilter.Commits)).toBe(ChildFilter.Commits)
    expect(shownFilter(counts, ChildFilter.All)).toBe(ChildFilter.All)
    // No files under this todo.
    expect(shownFilter(counts, ChildFilter.Files)).toBe(ChildFilter.All)
    expect(shownFilter([], ChildFilter.Links)).toBe(ChildFilter.All)
  })

  it('shows every child under All, in the order they came, and one kind’s under its filter', () => {
    expect(filterChildren(CHILDREN, ChildFilter.All)).toBe(CHILDREN)
    expect(filterChildren(CHILDREN, ChildFilter.Commits).map(({ key }) => key)).toEqual([
      'abc /code/api',
      'def /code/api',
      'fed /code/api',
    ])
    expect(filterChildren(CHILDREN, ChildFilter.Files)).toEqual([])
  })
})

describe('telling whether a card changed', () => {
  it('counts lists made anew as the same while they hold the same children, in the same order', () => {
    const again = CHILDREN.map((each) => ({ ...each, updatedAt: each.updatedAt + 5 }))
    expect(sameChildren(CHILDREN, CHILDREN)).toBe(true)
    expect(sameChildren(CHILDREN, again)).toBe(true)
    expect(sameChildren([], [])).toBe(true)
  })

  it('tells a child added, removed, moved in the order, or of another kind', () => {
    const [first, second, ...rest] = CHILDREN as [Child, Child, ...Child[]]
    expect(sameChildren(CHILDREN, [...CHILDREN, child(ChildKind.File, 'a.md')])).toBe(false)
    expect(sameChildren(CHILDREN, CHILDREN.slice(1))).toBe(false)
    expect(sameChildren(CHILDREN, [second, first, ...rest])).toBe(false)
    expect(sameChildren(CHILDREN, [{ ...first, kind: ChildKind.File }, second, ...rest])).toBe(false)
    expect(sameChildren(CHILDREN, [{ ...first, key: 'aaa /code/api' }, second, ...rest])).toBe(false)
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

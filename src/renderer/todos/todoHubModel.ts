/**
 * What the Todos tab shows as the hub (P16, #491; `docs/design/html/46-todo-hub.html`), worked out from each todo's
 * children: how many of each kind it has, what each count says in words, which filter an open todo is on, and the
 * children that filter shows. Pure, so it's tested on its own. Behind the hidden `todoHubEnabled` setting.
 */
import type { Todo } from '../../shared/domain'
import {
  ChildFilter,
  ChildKind,
  PRODUCED_KINDS,
  type Child,
  type ProducedKind,
  type TodoPanel,
} from '../../shared/todoHub'

/**
 * What the hub says in place of the summary, above the placeholder group, for a task that made things and kept no todo
 * list. One with nothing at all has the Todos tab's own empty state instead (`NoTodos`).
 */
export const NO_HUB_TODOS = 'No todos for this task.'

/** The placeholder group's heading: the children no todo has. */
export const UNFILED_HEADING = 'Not under a todo'

/** One kind of a todo's children, counted. */
export interface KindCount {
  readonly kind: ProducedKind
  readonly count: number
}

/**
 * A todo's children counted by kind, in the order its row shows them (files, links, changes), leaving out a kind it
 * has none of.
 */
export function kindCounts(children: readonly Child[]): KindCount[] {
  return PRODUCED_KINDS.flatMap((kind) => {
    const count = children.filter((child) => child.kind === kind).length
    return count === 0 ? [] : [{ kind, count }]
  })
}

/** A kind's name for one of its children, and for several. */
interface KindNames {
  readonly one: string
  readonly many: string
}

const KIND_NAMES: Readonly<Record<ProducedKind, KindNames>> = {
  [ChildKind.File]: { one: 'file', many: 'files' },
  [ChildKind.Link]: { one: 'link', many: 'links' },
  [ChildKind.Commit]: { one: 'change', many: 'changes' },
}

/** What a kind's count says in words, in its tooltip and to a screen reader: `3 links`, `1 change`. */
export function kindCountLabel({ kind, count }: KindCount): string {
  const names = KIND_NAMES[kind]
  return `${String(count)} ${count === 1 ? names.one : names.many}`
}

/** What a tile's kind is called, ahead of its title, to a screen reader: `File`, `Change`. */
export function kindLabel(kind: ProducedKind): string {
  const { one } = KIND_NAMES[kind]
  return `${one.charAt(0).toUpperCase()}${one.slice(1)}`
}

/** How a tile is named to a screen reader: its kind, then its title (`Change: Return Retry-After on 429s`). */
export function tileLabel(kind: ProducedKind, title: string): string {
  return `${kindLabel(kind)}: ${title}`
}

/** The filter that shows one kind alone. */
export function filterOfKind(kind: ProducedKind): ChildFilter {
  switch (kind) {
    case ChildKind.File:
      return ChildFilter.Files
    case ChildKind.Link:
      return ChildFilter.Links
    case ChildKind.Commit:
      return ChildFilter.Commits
  }
}

/**
 * The filter an open todo shows, under the one it remembers: that one while its kind still has children, else All. The
 * remembered one stays, for when the kind has some again.
 */
export function shownFilter(counts: readonly KindCount[], chosen: ChildFilter): ChildFilter {
  return counts.some(({ kind }) => filterOfKind(kind) === chosen) ? chosen : ChildFilter.All
}

/** The children a filter shows, in the order they came (most recently updated first). */
export function filterChildren(children: readonly Child[], filter: ChildFilter): readonly Child[] {
  return filter === ChildFilter.All ? children : children.filter(({ kind }) => filterOfKind(kind) === filter)
}

/**
 * Whether two lists of children show the same: the same children in the same order. The resolver makes every list
 * anew (`groupChildren`), so a todo whose children haven't changed is told by this.
 */
export function sameChildren(a: readonly Child[], b: readonly Child[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((child, index) => {
        const other = b[index]
        return other?.kind === child.kind && other.key === child.key
      }))
  )
}

/** Whether two todos show the same in their card: a todo list arrives whole, with every item made anew. */
export function sameTodo(a: Todo, b: Todo): boolean {
  return (
    a === b ||
    (a.id === b.id && a.text === b.text && a.state === b.state && a.note === b.note && a.completedAt === b.completedAt)
  )
}

/** How a todo's panel starts, until you open or filter it: closed, showing all. */
const CLOSED = { open: false, filter: ChildFilter.All } as const

/** What a panel remembers that its card shows: whether it's open, and its filter. */
export type PanelView = Pick<TodoPanel, 'open' | 'filter'>

/** A todo's panel as its card shows it: as you left it, or closed and showing all when you never changed it. */
export function panelView(panel: TodoPanel | undefined): PanelView {
  return panel ?? CLOSED
}

/** Whether two panels show the same. */
export function samePanel(a: TodoPanel | undefined, b: TodoPanel | undefined): boolean {
  const [shownA, shownB] = [panelView(a), panelView(b)]
  return shownA.open === shownB.open && shownA.filter === shownB.filter
}

import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faEye, faFile } from '@fortawesome/free-regular-svg-icons'
import { faChevronDown, faChevronRight, faCodeCommit, faLink, faSitemap } from '@fortawesome/free-solid-svg-icons'
import { memo, useEffect, useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import {
  TodoState,
  type Artifact,
  type EpochMs,
  type TaskCommit,
  type Todo,
  type TodoList,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import {
  ChildFilter,
  ChildKind,
  childRefKey,
  groupChildren,
  UNFILED_TODO_ID,
  type Child,
  type TodoId,
  type TodoPanel,
} from '../../shared/todoHub'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, todoMenu, useContextMenu, useMenuCommands, type ContextMenuTargetProps } from '../context-menus'
import { LinkedText } from '../links'
import { useGladeStore } from '../store/react'
import type { TodoPanels } from '../store/state'
import { formatAgo, formatFullDate } from '../task-header/headerModel'
import { useNow } from '../task-list/useNow'
import { ChildTile } from './tiles/ChildTile'
import { subagentsIn } from './tiles/childIndex'
import { askAboutTodo, STATE_LABELS, StateIcon } from './Todos'
import {
  filterChildren,
  filterOfKind,
  kindCountLabel,
  kindCounts,
  NO_HUB_TODOS,
  panelView,
  sameChildren,
  samePanel,
  sameTodo,
  shownFilter,
  UNFILED_HEADING,
  type KindCount,
  type PanelView,
} from './todoHubModel'
import { orderTodos, progressBar, progressHeading, todoProgress } from './todosModel'
import styles from './TodoHub.module.css'

const NO_TODOS: readonly Todo[] = []
const NO_ARTIFACTS: readonly Artifact[] = []
const NO_TOOL_EVENTS: readonly ToolEvent[] = []
const NO_WATCHERS: readonly Watcher[] = []
const NO_COMMITS: readonly TaskCommit[] = []
const NO_CHILDREN: readonly Child[] = []
const NO_PANELS: TodoPanels = {}

/** What marks a todo's head (and the placeholder group's) on the page: ↑ and ↓ move the focus between them. */
const HEAD_ATTRIBUTE = 'data-todo-head'

/** The icon of each kind of child, on its count and its filter pill. */
const KIND_ICONS: Readonly<Record<ChildKind, IconDefinition>> = {
  [ChildKind.File]: faFile,
  [ChildKind.Link]: faLink,
  [ChildKind.Subagent]: faSitemap,
  [ChildKind.Watcher]: faEye,
  [ChildKind.Commit]: faCodeCommit,
}

const STATE_CLASSES: Readonly<Record<TodoState, string | undefined>> = {
  [TodoState.Todo]: styles.todo,
  [TodoState.Doing]: styles.doing,
  [TodoState.Done]: styles.done,
  [TodoState.Waiting]: styles.waiting,
}

interface AgoProps {
  readonly at: EpochMs
  /** What it says before the time, to a screen reader alone (`Finished `) or to everyone (`updated `). */
  readonly prefix: string
  readonly prefixHidden?: boolean
  readonly className: string | undefined
}

/**
 * How long ago something happened, in words (`2m ago`, `just now`), with the exact time on hover. It keeps its own
 * clock: as time passes it renders again by itself, and the card around it doesn't.
 */
function Ago({ at, prefix, prefixHidden = false, className }: AgoProps): React.JSX.Element {
  const now = useNow()
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={formatFullDate(at)}>
      {prefixHidden ? <span className={styles.hidden}>{prefix}</span> : prefix}
      {formatAgo(at, now)}
    </time>
  )
}

interface KindsProps {
  readonly counts: readonly KindCount[]
  /** How many children there are of every kind: All's count. */
  readonly total: number
  readonly open: boolean
  /** The filter showing, while it's open. */
  readonly filter: ChildFilter
  /** Opens the todo on a filter, or changes an open one's. */
  readonly onShow: (filter: ChildFilter) => void
}

/**
 * A todo's third line, the same box closed and open, so opening it moves nothing above it. Closed: an icon and a count
 * per kind, a kind with none left out; clicking one opens the todo on that kind. Open: the same icons as filter pills,
 * with All in front. An icon is blue while one of its kind is live, with what it counts in words as its tooltip. A
 * kind's button is the same element closed and open, so the one you click keeps the focus as it becomes a pill.
 */
function Kinds({ counts, total, open, filter, onShow }: KindsProps): React.JSX.Element {
  return (
    <div
      className={classNames(styles.kinds, open && styles.pills)}
      {...(open ? { role: 'group', 'aria-label': 'Show' } : {})}
    >
      {open && (
        <button
          key="all"
          type="button"
          className={classNames(styles.pill, filter === ChildFilter.All && styles.on)}
          aria-label={`All ${String(total)}`}
          aria-pressed={filter === ChildFilter.All}
          onClick={() => {
            onShow(ChildFilter.All)
          }}
        >
          All<span className={styles.pillCount}>{total}</span>
        </button>
      )}
      {counts.map((count) => {
        const { kind, live } = count
        const label = kindCountLabel(count)
        const kindFilter = filterOfKind(kind)
        const selected = open && filter === kindFilter
        return (
          <button
            key={kind}
            type="button"
            className={classNames(open ? styles.pill : styles.count, selected && styles.on, live > 0 && styles.live)}
            // A closed todo's counts are for the pointer: with the keyboard, → opens the todo and Tab reaches its pills.
            tabIndex={open ? undefined : -1}
            aria-label={label}
            aria-pressed={open ? selected : undefined}
            title={label}
            data-kind={kind}
            data-live={live > 0 ? '' : undefined}
            onClick={() => {
              onShow(kindFilter)
            }}
          >
            <Icon icon={KIND_ICONS[kind]} size={IconSize.Small} />
            <span className={classNames(open && styles.pillCount)}>{count.count}</span>
          </button>
        )
      })}
    </div>
  )
}

interface TilesProps {
  readonly taskId: string
  /** What the list is under, for a screen reader: the todo's text, or the placeholder group's heading. */
  readonly under: string
  /** The children the filter shows, most recently updated first. */
  readonly shown: readonly Child[]
}

/** An open todo's children: one flat list, a tile each. Each tile reads its own child, so the list only orders them. */
function Tiles({ taskId, under, shown }: TilesProps): React.JSX.Element {
  return (
    <ul className={styles.tiles} aria-label={`Under ${under}`}>
      {shown.map(({ kind, key }) => (
        <li key={childRefKey({ kind, key })}>
          <ChildTile taskId={taskId} kind={kind} childKey={key} />
        </li>
      ))}
    </ul>
  )
}

/** What opens, closes and filters one todo's panel, from its children and how you left it. */
interface PanelControls {
  readonly counts: readonly KindCount[]
  /** Whether it shows its children: it's open, and has some. */
  readonly open: boolean
  /** The filter it shows them under: the one you chose, while its kind still has children. */
  readonly filter: ChildFilter
  readonly toggle: () => void
  readonly show: (filter: ChildFilter) => void
  /** → opens it, ← closes it, and ↵ or Space does what a click does, while its head has the focus. */
  readonly onKey: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * A todo's panel (or the placeholder group's): the store remembers it per task (`todoHub.setPanel`), so it's as you
 * left it across todos, tasks and relaunches. `todoId` is null for a todo nothing can be filed under.
 */
function usePanelControls(
  taskId: string,
  todoId: TodoId | null,
  childList: readonly Child[],
  panel: TodoPanel | undefined,
): PanelControls {
  const setTodoPanel = useGladeStore((state) => state.setTodoPanel)
  const counts = kindCounts(childList)
  const remembered = panelView(panel)
  const open = remembered.open && childList.length > 0
  const set = (next: PanelView): void => {
    if (todoId === null || childList.length === 0) return
    // It shows at once; one main couldn't remember is only forgotten on the next launch.
    setTodoPanel({ taskId, todoId, ...next }).catch(() => undefined)
  }
  const toggle = (): void => {
    set({ open: !open, filter: remembered.filter })
  }
  return {
    counts,
    open,
    filter: shownFilter(counts, remembered.filter),
    toggle,
    show: (filter) => {
      set({ open: true, filter })
    },
    onKey: (event) => {
      if (event.target !== event.currentTarget) return
      // A key held with a modifier is some other command's (⌥↓ is Next task).
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const wanted =
        event.key === 'Enter' || event.key === ' '
          ? !open
          : event.key === 'ArrowRight'
            ? true
            : event.key === 'ArrowLeft'
              ? false
              : null
      if (wanted === null) return
      event.preventDefault()
      if (wanted !== open) toggle()
    },
  }
}

/** Whether a click landed on a link in a todo's text, which opens the link and leaves the todo as it is. */
function onLink(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest('a') !== null
}

interface TodoCardProps {
  readonly taskId: string
  readonly todo: Todo
  /** Its children, most recently updated first; none for a todo with nothing under it. */
  readonly childList: readonly Child[]
  /** How you left its panel; undefined when you never opened or filtered it. */
  readonly panel: TodoPanel | undefined
  /** What its context menu is opened for: its row's key (`OrderedTodo.key`). */
  readonly menuKey: string
  /**
   * What makes its head open that menu, on a right-click or ⇧F10 while it has the focus (`useContextMenu`'s
   * `targetProps`): the same function for every card, so a card makes its own handlers once, not the hub with every
   * change.
   */
  readonly menuTargetProps: (key: string) => ContextMenuTargetProps
}

/** Whether a card shows the same: the hub makes its todos, children and lists anew with every change to the task. */
function sameCard(a: TodoCardProps, b: TodoCardProps): boolean {
  return (
    a.taskId === b.taskId &&
    a.menuKey === b.menuKey &&
    a.menuTargetProps === b.menuTargetProps &&
    sameTodo(a.todo, b.todo) &&
    samePanel(a.panel, b.panel) &&
    sameChildren(a.childList, b.childList)
  )
}

/**
 * One todo, as a card on `inner-2`, whatever its state and whether or not anything is under it. Three lines: its
 * title, its status line, and one row of icons (`Kinds`). Clicking its head opens it to one flat list of its children
 * (`Tiles`), which a closed todo never builds. A todo with nothing under it is its title alone, and doesn't open.
 */
const TodoCard = memo(function TodoCard({
  taskId,
  todo,
  childList,
  panel,
  menuKey,
  menuTargetProps,
}: TodoCardProps): React.JSX.Element {
  const { counts, open, filter, toggle, show, onKey } = usePanelControls(taskId, todo.id, childList, panel)
  const menuTarget = useMemo(() => menuTargetProps(menuKey), [menuTargetProps, menuKey])
  const parent = childList.length > 0
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    menuTarget.onKeyDown(event)
    if (!event.defaultPrevented) onKey(event)
  }
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (!onLink(event)) toggle()
  }
  return (
    <li className={classNames(styles.card, STATE_CLASSES[todo.state])} data-open={open ? '' : undefined}>
      <div
        className={classNames(styles.head, parent && styles.opens)}
        tabIndex={0}
        {...{ [HEAD_ATTRIBUTE]: '' }}
        {...(parent ? { role: 'button', 'aria-expanded': open, onClick } : {})}
        onContextMenu={menuTarget.onContextMenu}
        onKeyDown={onKeyDown}
      >
        <span className={styles.stateIcon} aria-hidden="true">
          <StateIcon state={todo.state} />
        </span>
        <div className={styles.main}>
          <div className={styles.titleRow}>
            <div className={styles.title}>
              <span className={styles.hidden}>{`${STATE_LABELS[todo.state]}: `}</span>
              <LinkedText text={todo.text} />
            </div>
            {todo.state === TodoState.Done && todo.completedAt !== null && (
              <Ago at={todo.completedAt} prefix="Finished " prefixHidden className={styles.when} />
            )}
            {parent && (
              <span className={styles.chevron} aria-hidden="true">
                <Icon icon={open ? faChevronDown : faChevronRight} size={IconSize.Small} />
              </span>
            )}
          </div>
          {todo.note !== null && (
            <div className={styles.note}>
              <LinkedText text={todo.note} />
            </div>
          )}
        </div>
      </div>
      {parent && (
        <div className={styles.under}>
          <Kinds counts={counts} total={childList.length} open={open} filter={filter} onShow={show} />
          {open && <Tiles taskId={taskId} under={todo.text} shown={filterChildren(childList, filter)} />}
        </div>
      )}
    </li>
  )
}, sameCard)

interface UnfiledCardProps {
  readonly taskId: string
  /** The children no todo has, most recently updated first: at least one. */
  readonly childList: readonly Child[]
  readonly panel: TodoPanel | undefined
  /** Whether the task has no todos: the group shows alone, open, with no heading to open or close it by. */
  readonly alone: boolean
}

function sameUnfiledCard(a: UnfiledCardProps, b: UnfiledCardProps): boolean {
  return (
    a.taskId === b.taskId &&
    a.alone === b.alone &&
    samePanel(a.panel, b.panel) &&
    sameChildren(a.childList, b.childList)
  )
}

/**
 * "Not under a todo": the placeholder group for the children no todo has (what a task made before the hub, and a
 * child whose todo was deleted), after the todos. A card as a todo is, closed or open, with its heading where a todo's
 * title is; it opens, filters and remembers as a todo does. In a task with no todos it's the whole list, always open.
 */
const UnfiledCard = memo(function UnfiledCard({
  taskId,
  childList,
  panel,
  alone,
}: UnfiledCardProps): React.JSX.Element {
  const controls = usePanelControls(taskId, UNFILED_TODO_ID, childList, panel)
  const { counts, filter, toggle, show, onKey } = controls
  const open = alone || controls.open
  return (
    <li className={classNames(styles.card, alone && styles.alone)} data-open={open ? '' : undefined}>
      {!alone && (
        <div
          className={classNames(styles.head, styles.opens, styles.unfiledHead)}
          tabIndex={0}
          {...{ [HEAD_ATTRIBUTE]: '' }}
          role="button"
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={onKey}
        >
          <span className={styles.stateIcon} aria-hidden="true">
            <Icon icon={open ? faChevronDown : faChevronRight} size={IconSize.Small} />
          </span>
          <span className={styles.unfiledHeading}>{UNFILED_HEADING}</span>
        </div>
      )}
      <div className={classNames(styles.under, alone && styles.flush)}>
        <Kinds counts={counts} total={childList.length} open={open} filter={filter} onShow={show} />
        {open && <Tiles taskId={taskId} under={UNFILED_HEADING} shown={filterChildren(childList, filter)} />}
      </div>
    </li>
  )
}, sameUnfiledCard)

/** How far through its todos the agent is, with a progress bar and when it last changed the list. */
const Summary = memo(function Summary({ list }: { readonly list: TodoList }): React.JSX.Element {
  const progress = todoProgress(list)
  const bar = progressBar(progress)
  return (
    <div className={styles.summary}>
      <div className={styles.headingRow}>
        <span className={styles.heading}>{progressHeading(progress)}</span>
        <Ago at={list.updatedAt} prefix="updated " className={styles.updated} />
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label="Todos done"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
      >
        <div className={styles.barDone} style={{ width: `${String(bar.done)}%` }} />
        <div className={styles.barDoing} style={{ width: `${String(bar.doing)}%` }} />
      </div>
    </div>
  )
})

/** ↑ and ↓ on a todo's head move the focus to the head before or after it, the placeholder group's included. */
function moveBetweenHeads(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  // ⌥↓ and ⌥↑ are Next and Previous task, wherever the focus is.
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const { target, currentTarget } = event
  if (!(target instanceof HTMLElement) || !target.hasAttribute(HEAD_ATTRIBUTE)) return
  event.preventDefault()
  const heads = [...currentTarget.querySelectorAll<HTMLElement>(`[${HEAD_ATTRIBUTE}]`)]
  heads[heads.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
}

export interface TodoHubProps {
  readonly taskId: string
  /** The task's todo list; null or undefined while the agent has kept none. */
  readonly list: TodoList | null | undefined
}

/**
 * The Todos tab as the hub (P16, #491; `docs/design/html/46-todo-hub.html` to `49-todo-hub-unfiled.html`), shown in
 * place of `Todos` while the hidden `todoHubEnabled` setting is on: everything a task made, ran and is waiting on,
 * under the todo it belongs to. Every todo is a card (`TodoCard`), in the tab's order (`orderTodos`), then the
 * placeholder group for what no todo has (`UnfiledCard`), hidden while it's empty.
 *
 * It works out which todo each child is under itself (`groupChildren`), from the lists the store already keeps for the
 * other tabs and the task's filings, so a child filed, moved or changed shows at once, with no reload. Every change to
 * the task lands here; a card renders again only when its own todo, children or panel changed (`sameCard`), and a tile
 * only when its own child did (`ChildTile`).
 */
export const TodoHub = memo(function TodoHub({ taskId, list }: TodoHubProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId]) ?? NO_ARTIFACTS
  const events = useGladeStore((state) => state.toolEvents[taskId]) ?? NO_TOOL_EVENTS
  const watchers = useGladeStore((state) => state.watchers[taskId]) ?? NO_WATCHERS
  const commits = useGladeStore((state) => state.commits[taskId]) ?? NO_COMMITS
  const filings = useGladeStore((state) => state.filings[taskId])
  const panels = useGladeStore((state) => state.todoPanels[taskId]) ?? NO_PANELS
  const loadTodoHub = useGladeStore((state) => state.loadTodoHub)
  const watchArtifacts = useGladeStore((state) => state.watchArtifacts)
  const unwatchArtifacts = useGladeStore((state) => state.unwatchArtifacts)
  const insertIntoInput = useGladeStore((state) => state.insertIntoInput)
  const menu = useContextMenu<string>()
  const { copy } = useMenuCommands()
  const todos = list?.items ?? NO_TODOS

  // The task's filings and its todos' panels, read as the tab shows the task; `filings.changed` keeps the filings
  // current from then on. A failed read leaves the todos showing with nothing under them.
  useEffect(() => {
    loadTodoHub(taskId).catch(() => undefined)
  }, [taskId, loadTodoHub])

  // While the tab shows the task, main watches its file artifacts for edits from anywhere, as it does for the
  // Artifacts tab: a file's place in its todo's list goes by when it last changed.
  useEffect(() => {
    watchArtifacts(taskId).catch(() => undefined)
    return () => {
      unwatchArtifacts(taskId).catch(() => undefined)
    }
  }, [taskId, watchArtifacts, unwatchArtifacts])

  const ordered = useMemo(() => orderTodos(todos), [todos])
  // Until the filings are read, nothing is grouped: every child would show under no todo for a moment.
  const grouped = useMemo(
    () =>
      filings === undefined
        ? null
        : groupChildren({ todos, artifacts, subagents: subagentsIn(events), watchers, commits, filings }),
    [todos, artifacts, events, watchers, commits, filings],
  )
  /** Each todo's children, by its row's key: an item with no id of its own (`at:…`) has none. */
  const childLists = useMemo(
    () => new Map(grouped?.todos.map(({ todoId, children }) => [`id:${todoId}`, children])),
    [grouped],
  )
  const unfiled = grouped?.unfiled.children ?? NO_CHILDREN

  // The menu is opened for a row's key, and finds its todo as it is by then.
  const { targetProps } = menu
  const entries = (key: string) => {
    const todo = ordered.find((row) => row.key === key)?.todo
    if (todo === undefined) return []
    return todoMenu({
      copy: () => {
        copy(todo.text)
      },
      ask: () => {
        insertIntoInput(taskId, askAboutTodo(todo))
      },
    })
  }

  return (
    <div className={styles.hub}>
      {list === null || list === undefined || todos.length === 0 ? (
        <p className={styles.empty}>{NO_HUB_TODOS}</p>
      ) : (
        <Summary list={list} />
      )}
      <ul className={styles.list} aria-label="Todos" onKeyDown={moveBetweenHeads}>
        {ordered.map(({ todo, key }) => (
          <TodoCard
            key={key}
            taskId={taskId}
            todo={todo}
            childList={childLists.get(key) ?? NO_CHILDREN}
            panel={todo.id === null ? undefined : panels[todo.id]}
            menuKey={key}
            menuTargetProps={targetProps}
          />
        ))}
        {unfiled.length > 0 && (
          <UnfiledCard taskId={taskId} childList={unfiled} panel={panels[UNFILED_TODO_ID]} alone={todos.length === 0} />
        )}
      </ul>
      <ContextMenu label="Todo actions" state={menu} entries={entries} />
    </div>
  )
})

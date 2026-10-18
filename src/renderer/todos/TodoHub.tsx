import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faFile } from '@fortawesome/free-regular-svg-icons'
import { faChevronDown, faChevronRight, faCodeCommit, faLink } from '@fortawesome/free-solid-svg-icons'
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  TodoState,
  type Artifact,
  type EpochMs,
  type TaskCommit,
  type Todo,
  type TodoList,
  type ToolEvent,
} from '../../shared/domain'
import {
  ChildFilter,
  ChildKind,
  refKey,
  groupChildren,
  UNFILED_TODO_ID,
  type Child,
  type ProducedKind,
  type TodoId,
  type TodoPanel,
} from '../../shared/todoHub'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, todoMenu, useContextMenu, useMenuCommands, type ContextMenuTargetProps } from '../context-menus'
import { useGladeStore } from '../store/react'
import type { TodoPanels } from '../store/state'
import { formatAgo, formatFullDate } from '../task-header/headerModel'
import { FOCUS_HIGHLIGHT_MS } from '../tool-log'
import { useNow } from '../task-list/useNow'
import { ArtifactTiles } from './tiles/ArtifactTiles'
import { ChildTile } from './tiles/ChildTile'
import { subagentsIn } from './tiles/childIndex'
import { LinkStateCluster } from './LinkStateViews'
import { askAboutTodo, NoTodos, STATE_LABELS, StateIcon } from './Todos'
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
import { linkAddresses, linkReferences, namedBy, NO_REFERENCES, sameReferences, type LinkReferences } from './todoLinks'
import { orderTodos, progressBar, progressHeading, todoProgress } from './todosModel'
import { TodoText } from './TodoText'
import styles from './TodoHub.module.css'

const NO_TODOS: readonly Todo[] = []
const NO_ARTIFACTS: readonly Artifact[] = []
const NO_TOOL_EVENTS: readonly ToolEvent[] = []
const NO_COMMITS: readonly TaskCommit[] = []
const NO_CHILDREN: readonly Child[] = []
const NO_PANELS: TodoPanels = {}
const NO_LINKS: ReadonlyMap<string, LinkReferences> = new Map<string, LinkReferences>()

/** What marks a todo's head (and the placeholder group's) on the page: ↑ and ↓ move the focus between them. */
const HEAD_ATTRIBUTE = 'data-todo-head'

/** What marks a todo's card on the page, holding the todo's id: what a request to show a todo looks for. */
const TODO_ATTRIBUTE = 'data-todo'

/** The icon of each kind of child, on its count and its filter pill. */
const KIND_ICONS: Readonly<Record<ProducedKind, IconDefinition>> = {
  [ChildKind.File]: faFile,
  [ChildKind.Link]: faLink,
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
  readonly taskId: string
  /** The children the row counts and, closed, says the state of: the GitHub links among them carry their watches. */
  readonly list: readonly Child[]
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
 * per kind (files, links, changes), a kind with none left out; clicking one opens the todo on that kind — and, after
 * the counts, what its linked pull requests and issues are, in their colours (#683). The counts pack from the left
 * into a counts area of fixed width, so the first, second and third element of the line start at the same place
 * from todo to todo, and the states right after that area (#727). Open: the same icons as filter
 * pills, with All in front, and no state: the tiles say it. Each count has what it counts in words as its tooltip,
 * and none is ever blue: nothing under a todo is live. A kind's button is the same element closed and open, so the
 * one you click keeps the focus as it becomes a pill.
 */
function Kinds({ taskId, list, counts, total, open, filter, onShow }: KindsProps): React.JSX.Element {
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
        const { kind } = count
        const label = kindCountLabel(count)
        const kindFilter = filterOfKind(kind)
        const selected = open && filter === kindFilter
        return (
          <button
            key={kind}
            type="button"
            className={classNames(open ? styles.pill : styles.count, selected && styles.on)}
            // A closed todo's counts are for the pointer: with the keyboard, → opens the todo and Tab reaches its pills.
            tabIndex={open ? undefined : -1}
            aria-label={label}
            aria-pressed={open ? selected : undefined}
            title={label}
            data-kind={kind}
            onClick={() => {
              onShow(kindFilter)
            }}
          >
            <Icon icon={KIND_ICONS[kind]} size={IconSize.Small} />
            <span className={classNames(open && styles.pillCount)}>{count.count}</span>
          </button>
        )
      })}
      {!open && (
        // The states' slot, after the counts': the CSS pins it to the row's last column, so it starts at the same
        // place on every todo whatever kinds those have (#727). Empty when nothing is watched.
        <span className={styles.states}>
          <LinkStateCluster taskId={taskId} list={list} />
        </span>
      )}
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

/**
 * An open todo's children: one flat list, a tile each. Each tile reads its own child, so the list only orders them.
 * Around it, what its file and link tiles keep once for the list (`ArtifactTiles`, #498): an artifact's context menu,
 * and the image viewer, which steps through this list's images alone.
 */
function Tiles({ taskId, under, shown }: TilesProps): React.JSX.Element {
  return (
    <ArtifactTiles taskId={taskId} shown={shown}>
      <ul className={styles.tiles} aria-label={`Under ${under}`}>
        {shown.map(({ kind, key }) => (
          <li key={refKey({ kind, key })}>
            <ChildTile taskId={taskId} kind={kind} childKey={key} />
          </li>
        ))}
      </ul>
    </ArtifactTiles>
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

/**
 * Whether a click on a todo's head is one that opens or closes the todo. A click on a link in its text opens the link
 * and leaves the todo as it is, and so does a choice from that link's menu: the menu is over the page, not in the
 * head, but React passes its clicks up through the link that opened it.
 */
function opensTodo(event: MouseEvent<HTMLElement>): boolean {
  const { target, currentTarget } = event
  return target instanceof Element && currentTarget.contains(target) && target.closest('a') === null
}

interface TodoCardProps {
  readonly taskId: string
  readonly todo: Todo
  /** Its children, most recently updated first; none for a todo with nothing under it. */
  readonly childList: readonly Child[]
  /** How you left its panel; undefined when you never opened or filtered it. */
  readonly panel: TodoPanel | undefined
  /**
   * The PRs, issues and tickets its title and status line name, of those the task has as links (`namedBy`): those
   * words are links to them (#500). None for most todos.
   */
  readonly links: LinkReferences
  /** What its context menu is opened for: its row's key (`OrderedTodo.key`). */
  readonly menuKey: string
  /**
   * What makes its head open that menu, on a right-click or ⇧F10 while it has the focus (`useContextMenu`'s
   * `targetProps`): the same function for every card, so a card makes its own handlers once, not the hub with every
   * change.
   */
  readonly menuTargetProps: (key: string) => ContextMenuTargetProps
  /** Whether the card is the one a request to show a todo asked for, highlighted for a moment (#684). */
  readonly highlighted: boolean
}

/** Whether a card shows the same: the hub makes its todos, children and lists anew with every change to the task. */
function sameCard(a: TodoCardProps, b: TodoCardProps): boolean {
  return (
    a.taskId === b.taskId &&
    a.menuKey === b.menuKey &&
    a.menuTargetProps === b.menuTargetProps &&
    a.highlighted === b.highlighted &&
    sameTodo(a.todo, b.todo) &&
    samePanel(a.panel, b.panel) &&
    sameReferences(a.links, b.links) &&
    sameChildren(a.childList, b.childList)
  )
}

/**
 * One todo, as a card on `inner-2`, whatever its state and whether or not anything is under it. Three lines: its
 * title, its status line, and one row of icons (`Kinds`). Clicking its head opens it to one flat list of its children
 * (`Tiles`), which a closed todo never builds. A todo with nothing under it is its title alone, and doesn't open. A PR,
 * an issue or a ticket its title or status line names is a link, when the task has it as one (`TodoText`).
 */
const TodoCard = memo(function TodoCard({
  taskId,
  todo,
  childList,
  panel,
  links,
  menuKey,
  menuTargetProps,
  highlighted,
}: TodoCardProps): React.JSX.Element {
  const { counts, open, filter, toggle, show, onKey } = usePanelControls(taskId, todo.id, childList, panel)
  const menuTarget = useMemo(() => menuTargetProps(menuKey), [menuTargetProps, menuKey])
  const parent = childList.length > 0
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    menuTarget.onKeyDown(event)
    if (!event.defaultPrevented) onKey(event)
  }
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (opensTodo(event)) toggle()
  }
  return (
    <li
      className={classNames(styles.card, highlighted && styles.highlighted, STATE_CLASSES[todo.state])}
      data-open={open ? '' : undefined}
      {...{ [TODO_ATTRIBUTE]: todo.id ?? undefined }}
    >
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
              <TodoText text={todo.text} links={links} />
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
              <TodoText text={todo.note} links={links} />
            </div>
          )}
        </div>
      </div>
      {parent && (
        <div className={styles.under}>
          <Kinds
            taskId={taskId}
            list={childList}
            counts={counts}
            total={childList.length}
            open={open}
            filter={filter}
            onShow={show}
          />
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
        <Kinds
          taskId={taskId}
          list={childList}
          counts={counts}
          total={childList.length}
          open={open}
          filter={filter}
          onShow={show}
        />
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
        <div className={styles.barWaiting} style={{ width: `${String(bar.waiting)}%` }} />
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
  /** A todo to show: it opens, scrolls into view, its head takes the focus, and it's highlighted for a moment. */
  readonly focus?: TodoShown | null | undefined
  /** Called once the hub has shown `focus`, so its owner can clear it. */
  readonly onFocusShown?: (() => void) | undefined
}

/** A request to show one todo in the hub. */
export interface TodoShown {
  readonly todoId: TodoId
  /** Goes up by one with every request, so asking for the same todo again is still a new request. */
  readonly request: number
}

/**
 * The Todos tab (P16, #491; `docs/design/html/46-todo-hub.html` to `49-todo-hub-unfiled.html`): what a task produced
 * (its files, links and commits), under the todo it belongs to. What's going on (subagents, watchers) is in the Agents
 * tab, and no todo shows any (#535). Every todo is a card (`TodoCard`), in the tab's order (`orderTodos`), then the
 * placeholder group for what no todo has (`UnfiledCard`), hidden while it's empty. A task with no todos that produced
 * something says so in a line above that group; one with nothing at all has the Todos tab's own empty state
 * (`NoTodos`).
 *
 * It works out which todo each child is under itself (`groupChildren`), from the lists the store already keeps for the
 * other tabs and the task's filings, so a child filed, moved or changed shows at once, with no reload. The tool log is
 * read for its subagents alone: a subagent's commits go under the todo it works on. Every change to
 * the task lands here; a card renders again only when its own todo, children or panel changed, or a link its text
 * names (`sameCard`), and a tile only when its own child did (`ChildTile`).
 *
 * Asked to show a todo (a `[text](todo:N)` link in a reply, #684, or the line under a subagent's tab in the Agents
 * tab, #536), it opens that todo's card, scrolls it into view, puts the focus on its head and highlights the card
 * for a moment, once the todo is in the list.
 */
export const TodoHub = memo(function TodoHub({ taskId, list, focus, onFocusShown }: TodoHubProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId]) ?? NO_ARTIFACTS
  const events = useGladeStore((state) => state.toolEvents[taskId]) ?? NO_TOOL_EVENTS
  const commits = useGladeStore((state) => state.commits[taskId]) ?? NO_COMMITS
  const filings = useGladeStore((state) => state.filings[taskId])
  const panels = useGladeStore((state) => state.todoPanels[taskId]) ?? NO_PANELS
  const loadTodoHub = useGladeStore((state) => state.loadTodoHub)
  const setTodoPanel = useGladeStore((state) => state.setTodoPanel)
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

  // While the tab shows the task, main watches its file artifacts for edits from anywhere, since a file's place in its todo's list goes by when it last changed.
  useEffect(() => {
    watchArtifacts(taskId).catch(() => undefined)
    return () => {
      unwatchArtifacts(taskId).catch(() => undefined)
    }
  }, [taskId, watchArtifacts, unwatchArtifacts])

  // The todos in the tab's order, grouped and ordered by state.
  const ordered = useMemo(() => orderTodos(todos), [todos])

  // Until the filings are read, nothing is grouped: every child would show under no todo for a moment.
  const grouped = useMemo(
    () =>
      filings === undefined
        ? null
        : groupChildren({ todos, artifacts, subagents: subagentsIn(events), commits, filings }),
    [todos, artifacts, events, commits, filings],
  )
  /** Each todo's children, by its row's key: an item with no id of its own (`at:…`) has none. */
  const childLists = useMemo(
    () => new Map(grouped?.todos.map(({ todoId, children }) => [`id:${todoId}`, children])),
    [grouped],
  )
  const unfiled = grouped?.unfiled.children ?? NO_CHILDREN

  // The card highlighted as the one a request to show a todo asked for, and the timer that takes the highlight off.
  const [highlighted, setHighlighted] = useState<TodoId | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    },
    [],
  )

  // Shows the todo asked for: it opens its card (when it has children), its card scrolls to the top of the list (#713:
  // "nearest" left a closed card at the bottom edge, its children opening out of view), its head takes
  // the focus, as ↑ and ↓ move it, and the card is highlighted for a moment (#684). Until the todo is in the list
  // (the task's logs still loading), or its children are (the filings still being read, whether it opens at all),
  // the request waits; one request is acted on once, whatever re-renders it.
  const hub = useRef<HTMLDivElement>(null)
  const handledFocus = useRef<number | null>(null)
  useEffect(() => {
    if (focus === null || focus === undefined || handledFocus.current === focus.request || filings === undefined) {
      return
    }
    const card = [...(hub.current?.querySelectorAll<HTMLElement>(`[${TODO_ATTRIBUTE}]`) ?? [])].find(
      (element) => element.getAttribute(TODO_ATTRIBUTE) === focus.todoId,
    )
    if (card === undefined) return
    handledFocus.current = focus.request
    const asLeft = panelView(panels[focus.todoId])
    const parent = (childLists.get(`id:${focus.todoId}`) ?? NO_CHILDREN).length > 0
    if (parent && !asLeft.open) {
      setTodoPanel({ taskId, todoId: focus.todoId, open: true, filter: asLeft.filter }).catch(() => undefined)
    }
    card.scrollIntoView({ block: 'start' })
    card.querySelector<HTMLElement>(`[${HEAD_ATTRIBUTE}]`)?.focus({ preventScroll: true })
    setHighlighted(focus.todoId)
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => {
      setHighlighted(null)
    }, FOCUS_HIGHLIGHT_MS)
    onFocusShown?.()
  }, [focus, onFocusShown, ordered, childLists, panels, filings, taskId, setTodoPanel])

  // What a todo's text may name (#500), worked out when the task's links change and not when anything else of its
  // artifacts does; then, per todo, the ones its own text names, read again only when the todos or the links change.
  const addresses = useMemo(() => linkAddresses(artifacts), [artifacts])
  const references = useMemo(() => linkReferences(addresses), [addresses])
  /** By a todo's row's key. A task with no PR, issue or ticket among its links reads no
   * todo's text. */
  const links = useMemo(() => {
    if (references.size === 0) return NO_LINKS
    const map = new Map<string, LinkReferences>()
    for (const { todo, key } of ordered) map.set(key, namedBy(todo, references))
    return map
  }, [ordered, references])

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

  // Nothing at all, neither a todo nor anything produced: with no todos, whatever the task produced is under no todo,
  // whatever its filings say, so this is known before they're read. Subagents and watchers don't count: a task with
  // only those has produced nothing.
  if (todos.length === 0 && artifacts.length === 0 && commits.length === 0) return <NoTodos />

  return (
    <div ref={hub} className={styles.hub}>
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
            links={links.get(key) ?? NO_REFERENCES}
            menuKey={key}
            menuTargetProps={targetProps}
            highlighted={todo.id !== null && todo.id === highlighted}
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

import { faChevronDown, faEye } from '@fortawesome/free-solid-svg-icons'
import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { EpochMs } from '../../shared/domain'
import { Icon, Menu, MenuAnchorKind, MenuEntryKind, Placement, type MenuEntry } from '../components'
import { classNames } from '../components/classNames'
import { moduleClass } from '../components/moduleClass'
import {
  agentTabMenu,
  ContextMenu,
  useContextMenu,
  useMenuCommands,
  type ContextMenuTargetProps,
} from '../context-menus'
import { NOW_REFRESH_MS, useNow } from '../task-list/useNow'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import {
  agentActivity,
  AgentActivity,
  deriveSubagents,
  isAgentActive,
  subagentLogText,
} from '../subagents/subagentsModel'
import { hasRunningWatcher, pinnedCount, watchingTitle } from './agentWatchersModel'
import {
  activeTabsCrowded,
  agentDotLabel,
  agentFinishedAgo,
  agentName,
  agentsOf,
  isRunning,
  mainTurnRunning,
  MAIN_AGENT_NAME,
  selectAgentTabs,
  selectShownAgent,
  type AgentId,
} from './agentsModel'
import styles from './AgentsTab.module.css'

/** The id of an agent's tab on the page, which its list is labelled by. */
export function agentTabId(agentId: AgentId): string {
  return agentId === null ? 'agent-tab-main' : `agent-tab-${agentId}`
}

/** The id of the selected agent's side of the tab: the line about its todo, and its tool calls. */
export const AGENT_PANEL_ID = 'agent-panel'

/** What marks an agent's tab on the page, holding its id (empty for Main): ← and → move between them. */
const AGENT_ATTRIBUTE = 'data-agent'

/** Keys that move between agents, and which way. */
const STEPS: Readonly<Partial<Record<string, number>>> = {
  ArrowRight: 1,
  ArrowLeft: -1,
}

/** The agent a tab on the page is, from its mark. */
function agentOf(tab: HTMLElement): AgentId {
  const id = tab.getAttribute(AGENT_ATTRIBUTE)
  return id === null || id === '' ? null : id
}

/** The gap between tabs in the active row (`.rest`'s `gap: var(--space-xs)`, `AgentsTab.module.css`): kept here too,
 * so the crowded check's maths matches what's actually laid out. */
const ROW_GAP_PX = 4

/** Toggled on the active row by a `ResizeObserver`, never by React state (#617): the row's own width changing isn't
 * data any tab renders on, so nothing here costs a tab a re-render, the same way the old strip's scroll position
 * never did. `AgentsTab.module.css`'s `.rest.crowded .activeTab` draws what it means. */
const CROWDED_CLASS = moduleClass(styles, 'crowded')

interface AgentTabProps {
  readonly taskId: string
  readonly agentId: AgentId
  readonly onSelect: (agentId: AgentId) => void
  /** What opens a subagent's menu from its tab, by its id. Main's tab has no menu. */
  readonly menuTarget: (agentId: string) => ContextMenuTargetProps
  /** Whether this tab shares the active row's width (every subagent's tab, Main's never): past `MIN_ACTIVE_TAB_WIDTH`
   * it drops to the smaller type and whatever of its name still fits (#617, `.rest.crowded .activeTab`). */
  readonly shared?: boolean
  /** Whether this is the strip's temporary tab: a finished subagent shown because it's the one selected (#617). It
   * sits after the active ones, with a dashed outline, and goes once Main or an active subagent is picked. */
  readonly temporary?: boolean
}

/**
 * One agent's tab in the strip: a dot, blue while the agent is active (its own turn running, or a watcher, wakeup,
 * background command or child it started still alive under it, #579) and slate once nothing under it is, then its
 * name. Main's tab is this alone, pinned before the rest, no pin icon (#617). Then an eye with a count while the
 * agent has anything pinned under its tool calls (#537), blue when a watcher's process runs and grey when all it has
 * is scheduled. It reads its own name, state, count and whether it's the one showing from the store, so a change to
 * one agent renders that agent's tab and no other, and picking another renders the two that changed. The tab showing
 * holds the strip's one tab stop. A subagent's tab opens its menu on a right-click and the keyboard's menu key.
 */
const AgentTab = memo(function AgentTab({
  taskId,
  agentId,
  onSelect,
  menuTarget,
  shared = false,
  temporary = false,
}: AgentTabProps): React.JSX.Element {
  const selected = useGladeStore((state) => selectShownAgent(state, taskId) === agentId)
  const name = useGladeStore((state) =>
    agentId === null ? MAIN_AGENT_NAME : agentName(agentsOf(state.toolEvents[taskId]).calls.get(agentId)),
  )
  // `data-running` keeps its narrower meaning (the agent's own turn running now), which Stop subagent and the e2e
  // suite read; the tab's colour and label go by the wider activity rule instead (#579).
  const running = useGladeStore((state) => {
    const call = agentId === null ? undefined : agentsOf(state.toolEvents[taskId]).calls.get(agentId)
    return call !== undefined && isRunning(call)
  })
  const activity = useGladeStore((state) => {
    const task = state.tasks[taskId]
    return (
      agentActivity(state.toolEvents[taskId], state.watchers[taskId], mainTurnRunning(task)).get(agentId) ??
      AgentActivity.Done
    )
  })
  const active = isAgentActive(activity)
  const watching = useGladeStore((state) => pinnedCount(state.watchers[taskId], agentId))
  const watchingLive = useGladeStore((state) => hasRunningWatcher(state.watchers[taskId], agentId))
  const watchingSays = watching > 0 ? watchingTitle(watching) : null

  return (
    <button
      type="button"
      role="tab"
      id={agentTabId(agentId)}
      aria-selected={selected}
      aria-controls={selected ? AGENT_PANEL_ID : undefined}
      tabIndex={selected ? 0 : -1}
      className={classNames(styles.tab, shared && styles.activeTab, temporary && styles.temporaryTab)}
      title={name}
      {...{ [AGENT_ATTRIBUTE]: agentId ?? '' }}
      data-running={running ? '' : undefined}
      data-active={active ? '' : undefined}
      onClick={() => {
        onSelect(agentId)
      }}
      {...(agentId === null ? {} : menuTarget(agentId))}
    >
      <span
        className={classNames(styles.dot, active && styles.active)}
        role="img"
        aria-label={agentDotLabel(activity)}
      />
      <span className={styles.name}>{name}</span>
      {watchingSays !== null && (
        <span
          className={classNames(styles.watching, !watchingLive && styles.idle)}
          role="img"
          aria-label={watchingSays}
          title={watchingSays}
          data-live={watchingLive ? '' : undefined}
        >
          <Icon icon={faEye} className={styles.watchingIcon} />
          {watching}
        </span>
      )}
    </button>
  )
})

interface FinishedRowProps {
  readonly taskId: string
  readonly agentId: string
  readonly now: EpochMs
}

/** A finished subagent's row in the caret's dropdown (#617): its name at the left, how long ago it finished at the
 * right. It reads its own call from the store, so the list doesn't re-render a row whose subagent hasn't changed. */
const FinishedRow = memo(function FinishedRow({ taskId, agentId, now }: FinishedRowProps): React.JSX.Element | null {
  const call = useGladeStore((state) => agentsOf(state.toolEvents[taskId]).calls.get(agentId))
  if (call === undefined) return null
  const ago = agentFinishedAgo(call, now)
  return (
    <span className={styles.finishedRow}>
      <span className={styles.dot} />
      <span className={styles.finishedName}>{agentName(call)}</span>
      {ago !== null && <span className={styles.finishedAgo}>{ago}</span>}
    </span>
  )
})

export interface AgentStripProps {
  readonly taskId: string
  /** The workspace root, so a copied log's file arguments are relative to it. */
  readonly rootPath?: string | undefined
}

/**
 * The strip of the Agents tab (`docs/design/html/54-agents-strip-*.html`, #617): Main first, its dot alone, no pin
 * icon; then every active subagent (running, or waiting on something it started, #579) sharing the rest of the width
 * evenly down to a 56px floor, past which its name drops to smaller type and whatever still fits; then, only while
 * something has finished, a caret with that count, opening "Finished, newest first" — picking one from it shows it as
 * a temporary tab after the active ones, with a grey dot and a dashed outline, which stays for as long as it's the
 * one selected (even once it's no longer freshly picked, or if it finishes while already shown) and goes once Main or
 * an active subagent is chosen.
 *
 * It's one tab stop, on the tab showing; ← and → pick the agent before or after, wrapping at the ends. The caret is a
 * separate tab stop after them, reached by Tab, never by the arrows.
 *
 * A subagent's tab has a context menu (#537): Copy log, and Stop subagent while it runs. Its log is read from the
 * store as the menu opens, so the strip doesn't render with the log.
 *
 * It reads the task's agent tabs (`selectAgentTabs`, #617) and the agent showing, so it renders when the active or
 * finished sets change, or when the agent shown does: not when anything else of the task changes. Each tab reads its
 * own.
 */
export const AgentStrip = memo(function AgentStrip({ taskId, rootPath }: AgentStripProps): React.JSX.Element {
  const { active: activeIds, finished: finishedIds } = useGladeStore(
    useShallow((state) => selectAgentTabs(state, taskId)),
  )
  const selectedAgentId = useGladeStore((state) => selectShownAgent(state, taskId))
  const selectAgentTab = useGladeStore((state) => state.selectAgentTab)
  const stopSubagent = useGladeStore((state) => state.stopSubagent)
  const store = useGladeStoreApi()
  const menu = useContextMenu<string>()
  const { run, copy } = useMenuCommands()
  const row = useRef<HTMLDivElement>(null)
  const [caretAnchor, setCaretAnchor] = useState<HTMLElement | null>(null)
  const dropdownOpen = caretAnchor !== null
  const now = useNow(dropdownOpen ? NOW_REFRESH_MS : null)

  // The selected agent shows as a temporary tab, after the active ones, for as long as it's finished and selected
  // (#617): the strip needs no state of its own for this, since it's exactly what `selectedAgentId` and `finishedIds`
  // already say.
  const temporaryTab = selectedAgentId !== null && finishedIds.includes(selectedAgentId) ? selectedAgentId : null
  const sharedIds = temporaryTab === null ? activeIds : [...activeIds, temporaryTab]

  useLayoutEffect(() => {
    const element = row.current
    if (element === null) return
    const update = (): void => {
      element.classList.toggle(CROWDED_CLASS, activeTabsCrowded(element.clientWidth, sharedIds.length, ROW_GAP_PX))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
    // Only the count of tabs sharing the row changes what the same width means; the observer catches the row's own
    // resizing.
  }, [sharedIds.length])

  const entries = (agentId: string) => {
    const subagent = deriveSubagents(store.getState().toolEvents[taskId] ?? []).find(
      ({ call }) => call.toolUseId === agentId,
    )
    if (subagent === undefined) return []
    return agentTabMenu({
      copyLog: () => {
        copy(subagentLogText(subagent, rootPath))
      },
      stop: isRunning(subagent.call)
        ? () => {
            run(() => stopSubagent(taskId, agentId))
          }
        : null,
    })
  }

  const select = useCallback(
    (agentId: AgentId): void => {
      // It shows at once; one main couldn't remember is only forgotten on the next launch.
      selectAgentTab(taskId, agentId).catch(() => undefined)
    },
    [selectAgentTab, taskId],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = STEPS[event.key]
    // A key held with a modifier is some other command's.
    if (step === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${AGENT_ATTRIBUTE}]`)]
    const at = tabs.findIndex((tab) => tab === event.target)
    const next = tabs[(at + step + tabs.length) % tabs.length]
    if (at === -1 || next === undefined) return
    event.preventDefault()
    select(agentOf(next))
    next.focus()
  }

  const finishedCalls = agentsOf(store.getState().toolEvents[taskId]).calls
  const finishedEntries: MenuEntry[] =
    finishedIds.length === 0
      ? []
      : [
          { kind: MenuEntryKind.Heading, label: 'Finished, newest first' },
          ...finishedIds.map((id): MenuEntry => ({
            kind: MenuEntryKind.Item,
            label: agentName(finishedCalls.get(id)),
            className: styles.finishedItem,
            content: <FinishedRow taskId={taskId} agentId={id} now={now} />,
            onSelect: () => {
              select(id)
            },
          })),
        ]

  return (
    // The arrow keys are the tabs' own: the strip only hears them from the tab that has the focus.
    <div className={styles.strip} role="tablist" aria-label="Agents" onKeyDown={onKeyDown}>
      <AgentTab taskId={taskId} agentId={null} onSelect={select} menuTarget={menu.targetProps} />
      <div ref={row} className={styles.rest} role="presentation">
        {sharedIds.map((id) => (
          <AgentTab
            key={id}
            taskId={taskId}
            agentId={id}
            onSelect={select}
            menuTarget={menu.targetProps}
            shared
            temporary={id === temporaryTab}
          />
        ))}
      </div>
      {finishedIds.length > 0 && (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={dropdownOpen}
          aria-label={`${String(finishedIds.length)} finished subagents`}
          title={`${String(finishedIds.length)} finished`}
          className={styles.caret}
          onClick={(event) => {
            setCaretAnchor(dropdownOpen ? null : event.currentTarget)
          }}
        >
          <Icon icon={faChevronDown} className={classNames(styles.caretIcon, dropdownOpen && styles.caretIconOpen)} />
          <span>{finishedIds.length}</span>
        </button>
      )}
      <Menu
        label="Finished subagents"
        entries={finishedEntries}
        anchor={{ kind: MenuAnchorKind.Element, element: caretAnchor, placement: Placement.BottomEnd }}
        open={dropdownOpen}
        onClose={() => {
          setCaretAnchor(null)
        }}
        className={styles.finishedMenu}
      />
      <ContextMenu label="Subagent actions" state={menu} entries={entries} />
    </div>
  )
})

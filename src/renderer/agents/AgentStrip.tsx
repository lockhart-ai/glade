import { faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { memo, useCallback, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon, revealScroll, ScrollRow } from '../components'
import { classNames } from '../components/classNames'
import { useGladeStore } from '../store/react'
import {
  agentDotLabel,
  agentName,
  agentsOf,
  isRunning,
  MAIN_AGENT_NAME,
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

/** Scrolls the subagents' row so its selected tab shows whole, if it has one that doesn't. */
function revealSelected(row: HTMLElement, behavior: ScrollBehavior): void {
  const tab = row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  const left = tab === null ? null : revealScroll(row, tab)
  if (left !== null) row.scrollTo({ left, behavior })
}

interface AgentTabProps {
  readonly taskId: string
  readonly agentId: AgentId
  readonly onSelect: (agentId: AgentId) => void
}

/**
 * One agent's tab in the strip: Main's, with the sidebar's pin, or a subagent's, with its dot (blue while it runs,
 * slate once it's done) and its name. It reads its own name, state and whether it's the one showing from the store, so
 * a change to one agent renders that agent's tab and no other, and picking another renders the two that changed. The
 * tab showing holds the strip's one tab stop.
 */
const AgentTab = memo(function AgentTab({ taskId, agentId, onSelect }: AgentTabProps): React.JSX.Element {
  const selected = useGladeStore((state) => selectShownAgent(state, taskId) === agentId)
  const name = useGladeStore((state) =>
    agentId === null ? MAIN_AGENT_NAME : agentName(agentsOf(state.toolEvents[taskId]).calls.get(agentId)),
  )
  const running = useGladeStore((state) => {
    const call = agentId === null ? undefined : agentsOf(state.toolEvents[taskId]).calls.get(agentId)
    return call !== undefined && isRunning(call)
  })
  const button = useRef<HTMLButtonElement>(null)

  // A subagent's tab scrolls into view as it becomes the one showing, however it was picked: smoothly (the row's
  // `scroll-behavior`), but for the first showing, which goes straight there. Main's is outside the row that scrolls.
  const shown = useRef(false)
  useLayoutEffect(() => {
    const row = button.current?.parentElement
    if (selected && agentId !== null && row !== null && row !== undefined) {
      revealSelected(row, shown.current ? 'auto' : 'instant')
    }
    shown.current = true
  }, [selected, agentId])

  return (
    <button
      ref={button}
      type="button"
      role="tab"
      id={agentTabId(agentId)}
      aria-selected={selected}
      aria-controls={selected ? AGENT_PANEL_ID : undefined}
      tabIndex={selected ? 0 : -1}
      className={styles.tab}
      title={name}
      {...{ [AGENT_ATTRIBUTE]: agentId ?? '' }}
      data-running={running ? '' : undefined}
      onClick={() => {
        onSelect(agentId)
      }}
    >
      {agentId === null ? (
        <Icon icon={faThumbtack} className={styles.pin} />
      ) : (
        <span
          className={classNames(styles.dot, running && styles.running)}
          role="img"
          aria-label={agentDotLabel(running)}
        />
      )}
      <span className={styles.name}>{name}</span>
      {/* #537 puts the eye here, with a count, while the agent has a watcher live or scheduled. */}
    </button>
  )
})

export interface AgentStripProps {
  readonly taskId: string
}

/**
 * The strip of the Agents tab (`docs/design/html/50-agents.html`, `54-agents-overflow.html`): a tab for every agent in
 * the task. Main, the task's own agent, is pinned first and stays put; after it the subagents that are running, then
 * the finished ones, the newest first within each, in a row that scrolls sideways when they don't fit, with a chevron
 * over a fade at an end with more past it (`ScrollRow`, as the panel's own tabs).
 *
 * It's one tab stop, on the tab showing; ← and → pick the agent before or after, wrapping at the ends.
 *
 * It reads only the order of the task's subagents, so it renders when one starts, or moves between the running and the
 * finished: not when another agent is picked, and not when anything else of the task changes. Each tab reads its own.
 */
export const AgentStrip = memo(function AgentStrip({ taskId }: AgentStripProps): React.JSX.Element {
  const ids = useGladeStore(useShallow((state) => agentsOf(state.toolEvents[taskId]).ids))
  const selectAgentTab = useGladeStore((state) => state.selectAgentTab)
  const row = useRef<HTMLDivElement>(null)

  const select = useCallback(
    (agentId: AgentId): void => {
      // It shows at once; one main couldn't remember is only forgotten on the next launch.
      selectAgentTab(taskId, agentId).catch(() => undefined)
    },
    [selectAgentTab, taskId],
  )

  // The tab showing stays in view when it moves (its subagent finished, or was woken) and when the row's width
  // changes: straight there, rather than chase the layout. Picking a tab is the tab's own to scroll to.
  const place = useRef<{ readonly agentId: AgentId; readonly index: number } | null>(null)
  useLayoutEffect(() => {
    const element = row.current
    if (element === null) return
    const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
    const index = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
    const shown = tabs[index]
    const now = shown === undefined ? null : { agentId: agentOf(shown), index }
    const before = place.current
    place.current = now
    if (now !== null && before !== null && before.agentId === now.agentId && before.index !== now.index) {
      revealSelected(element, 'instant')
    }
  }, [ids])
  useLayoutEffect(() => {
    const element = row.current
    if (element === null) return
    // A ResizeObserver calls back as it starts watching too: only a change of width counts.
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      revealSelected(element, 'instant')
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

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

  return (
    // The arrow keys are the tabs' own: the strip only hears them from the tab that has the focus.
    <div className={styles.strip} role="tablist" aria-label="Agents" onKeyDown={onKeyDown}>
      <AgentTab taskId={taskId} agentId={null} onSelect={select} />
      <ScrollRow
        listRef={row}
        content={ids.join('\n')}
        count={ids.length}
        noun="agents"
        className={styles.rest}
        rowClassName={styles.row}
        role="presentation"
      >
        {ids.map((id) => (
          <AgentTab key={id} taskId={taskId} agentId={id} onSelect={select} />
        ))}
      </ScrollRow>
    </div>
  )
})

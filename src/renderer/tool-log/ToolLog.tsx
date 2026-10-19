import { faEye } from '@fortawesome/free-regular-svg-icons'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ToolCallState,
  ToolEventKind,
  WatcherState,
  type Message,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { isSubagentTool } from '../../shared/subagents'
import { TaskIndicator } from '../../shared/taskIndicator'
import { agentCallResult, isRunning } from '../agents/agentsModel'
import { endedLabel, endedOutputLine, endedSummary, endedTime } from '../agents/agentWatchersModel'
import { useElapsedNow } from '../agents/useElapsedNow'
import { clockTime } from '../chat/chatModel'
import { InlineMarkdown } from '../chat/Markdown'
import { useKeepScrollOnPrepend, useLoadOlderOnScroll } from '../history/useOlderHistory'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { visibleLog } from '../store/visibleLog'
import { useStickToBottom } from '../chat/useStickToBottom'
import { classNames } from '../components/classNames'
import { moduleClass } from '../components/moduleClass'
import { Collapse, Dot, Icon } from '../components'
import { LinkedText } from '../links'
import type { PermissionLines } from '../permissions/permissionLineModel'
import { PermissionLineView } from '../permissions/PermissionLine'
import { kindLabel, whatLine } from '../watchers/watchersModel'
import {
  AgentLogRowKind,
  agentLogRows,
  argumentSummary,
  callIndicator,
  callStateLabel,
  COMPACTION_NAME,
  compactionArgument,
  compactionResult,
  githubNoticeLinks,
  resultSummary,
  rowEvent,
  rowIndicator,
  rowStateLabel,
  sameSubagentRow,
  showsCallState,
  showsResult,
  type CallRow,
  type CompactionRow,
  type DividerRow,
  type GithubNoticeRow,
  type LogWatchers,
  type NarrationRow,
} from './toolLogModel'
import { ToolCallMenu, useToolCallMenuTarget } from './ToolCallMenu'
import styles from './ToolLog.module.css'

/** How long the start of a turn the chat asked to see stays highlighted. */
export const FOCUS_HIGHLIGHT_MS = 1600

/** The class that highlights the start of a turn the chat asked to see. */
export const HIGHLIGHT_CLASS = moduleClass(styles, 'highlighted')

/** The attribute on each turn's first row, holding the turn: what a request to show a turn scrolls to. */
const TURN_START = 'data-turn-start'

/** A turn to scroll to and highlight, from a request to show it (see `ToolLogFocus`). */
export interface TurnFocus {
  readonly turn: number
  readonly request: number
}

/** The row highlighted as the turn the chat asked to see, and the timer that takes the highlight off. */
interface Highlight {
  readonly element: HTMLElement
  readonly timer: ReturnType<typeof setTimeout>
}

/** Each top-level row's mark: the turn it starts, when it's the first row of its turn. */
interface TurnStartProps {
  readonly turnStart?: number | undefined
}

interface CallProps extends TurnStartProps {
  readonly row: CallRow
  readonly rootPath: string | undefined
}

/**
 * Whether a call's row would render the same: its row, which is made anew each time the log's are, by what it holds.
 * The log's rows are memoised (#413): a long log is a thousand or more of them, and the log renders again with every
 * event, so only the rows whose own data changed render.
 */
function sameCall(a: CallProps, b: CallProps): boolean {
  return sameSubagentRow(a.row, b.row) && a.rootPath === b.rootPath && a.turnStart === b.turnStart
}

/** A call's first line: its dot, the tool's name, its argument and when it was made. */
function CallLine({ row, rootPath }: Pick<CallProps, 'row' | 'rootPath'>): React.JSX.Element {
  const { call, name } = row
  return (
    <span className={styles.callLine}>
      <Dot state={rowIndicator(row)} label={rowStateLabel(row)} />
      <span className={styles.name}>{name}</span>
      <span className={styles.argument}>{argumentSummary(call, rootPath)}</span>
      <span className={styles.time}>{clockTime(call.createdAt)}</span>
    </span>
  )
}

/**
 * One tool call: its name, argument, time and short result. Click it to see its full output; right-click it, or ⇧F10 on
 * it, for its context menu. A call a permission was decided about shows it on a line of its own under the call, shield
 * first (`PermissionLineView`). While its card is still open, its dot is the purple of waiting on you, and it has no
 * result yet to show; one whose request was withdrawn never ran, so its dot is slate, not a failed call's pink
 * (`docs/design/html/23-permission-card.html`, `24-permissions-picker.html`).
 */
const Call = memo(function Call({ row, rootPath, turnStart }: CallProps): React.JSX.Element {
  const { call, name, permission } = row
  const [expanded, setExpanded] = useState(false)
  const menuTarget = useToolCallMenuTarget(call)

  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        className={classNames(styles.call, showsCallState(row) && styles[call.state])}
        data-state={call.state}
        {...menuTarget}
      >
        <button
          type="button"
          className={styles.callButton}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((open) => !open)
          }}
        >
          <CallLine row={row} rootPath={rootPath} />
          {permission !== null && <PermissionLineView line={permission} className={styles.permission} />}
          {showsResult(row) && <span className={styles.result}>{resultSummary(call)}</span>}
        </button>
        <Collapse open={expanded}>
          <pre className={styles.output} aria-label={`${name} output`}>
            {call.output === null ? (
              call.state === ToolCallState.Running && 'No output yet.'
            ) : (
              <LinkedText text={call.output} />
            )}
          </pre>
        </Collapse>
      </div>
    </div>
  )
}, sameCall)

/**
 * How a subagent's call reads under its first line: its state and how long it has run, then what it came to
 * (`agentCallResult`). It keeps its own clock while the subagent runs, so as time passes it renders again by itself,
 * and the row around it doesn't.
 */
function AgentCallResult({ call }: { readonly call: ToolCallEvent }): string {
  const now = useElapsedNow(isRunning(call) ? call.createdAt : null)
  return agentCallResult(call, now)
}

interface AgentCallProps extends TurnStartProps {
  readonly row: CallRow
  readonly rootPath: string | undefined
  /** Shows the subagent the call started, by the call's `tool_use` id. */
  readonly onOpen: (agentId: string) => void
}

function sameAgentCall(a: AgentCallProps, b: AgentCallProps): boolean {
  return (
    sameSubagentRow(a.row, b.row) && a.rootPath === b.rootPath && a.turnStart === b.turnStart && a.onOpen === b.onOpen
  )
}

/**
 * A call that started a subagent, in the Agents tab (P16, #536; `docs/design/html/50-agents.html`): a tool call's row,
 * live while the subagent runs ("Running · 29m" on the running call's highlight), then how it ended, how long it ran
 * and the first line of what it came to ("Done · 28m · Opened PR #511"). While it runs, the SDK's summary of what it's
 * doing now is under that, on one line with the whole of it in its tooltip (#278, #537). Clicking it goes to the subagent's own tab, where what it did is, rather than opening the call's
 * output; its context menu is a tool call's.
 */
const AgentCall = memo(function AgentCall({ row, rootPath, turnStart, onOpen }: AgentCallProps): React.JSX.Element {
  const { call, permission } = row
  const menuTarget = useToolCallMenuTarget(call)
  const doing = isRunning(call) ? call.progressSummary : null
  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        className={classNames(styles.call, showsCallState(row) && styles[call.state])}
        data-state={call.state}
        data-agent-call={call.toolUseId}
        {...menuTarget}
      >
        <button
          type="button"
          className={styles.callButton}
          onClick={() => {
            onOpen(call.toolUseId)
          }}
        >
          <CallLine row={row} rootPath={rootPath} />
          {permission !== null && <PermissionLineView line={permission} className={styles.permission} />}
          {showsResult(row) && (
            <span className={styles.result}>
              <AgentCallResult call={call} />
            </span>
          )}
          {doing !== null && showsResult(row) && (
            <span className={styles.doing} title={doing}>
              {doing}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}, sameAgentCall)

/**
 * A watcher that has ended, in its agent's list at the time it ended (P16, #537;
 * `docs/design/html/53-agents-watcher-done.html`): a tool call's row with the eye where a call's dot goes. Its first
 * line is what kind it was, what the agent called it (what it ran is its tooltip) and when it ended; under it, how it
 * ended, how long it ran and how often it woke the agent; then what it last reported, or how it ended. One that
 * finished or was stopped is grey, whatever it found; one whose own command failed is pink.
 */
const EndedWatcher = memo(function EndedWatcher({ watcher }: { readonly watcher: Watcher }): React.JSX.Element {
  const kind = kindLabel(watcher.kind)
  const output = endedOutputLine(watcher)
  return (
    <div className={styles.callGroup}>
      <div
        role="group"
        aria-label={`${kind} ${watcher.label}`}
        className={classNames(
          styles.call,
          styles.watcher,
          watcher.state === WatcherState.Failed && styles.failedWatcher,
        )}
        data-state={watcher.state}
        data-watcher={watcher.id}
      >
        <span className={styles.callLine}>
          <span className={styles.eye} role="img" aria-label="Watcher">
            <Icon icon={faEye} />
          </span>
          <span className={styles.name}>{kind}</span>
          <span className={styles.argument} title={whatLine(watcher)}>
            {watcher.label}
          </span>
          <span className={styles.time}>{clockTime(endedTime(watcher))}</span>
        </span>
        <span className={styles.result}>
          <span className={styles.ended}>{endedLabel(watcher)}</span> · {endedSummary(watcher)}
        </span>
        {output !== null && (
          <span className={styles.report}>
            <span className={styles.reportLabel}>{output.kind}</span>
            <span className={styles.reportText} title={output.text}>
              <LinkedText text={output.text} />
            </span>
          </span>
        )}
      </div>
    </div>
  )
})

/**
 * A compaction of the context, laid out like a tool call: "Compact  198k → 41k tokens". Once it has the summary it
 * wrote, click it to see what the agent carried over, as a call opens its output.
 */
const Compaction = memo(function Compaction({
  compaction,
  turnStart,
}: CompactionRow & TurnStartProps): React.JSX.Element {
  const { state, summary } = compaction
  const [expanded, setExpanded] = useState(false)
  const line = (
    <>
      <span className={styles.callLine}>
        <Dot state={callIndicator(state)} label={callStateLabel(state)} />
        <span className={styles.name}>{COMPACTION_NAME}</span>
        <span className={styles.argument}>{compactionArgument(compaction)}</span>
        <span className={styles.time}>{clockTime(compaction.createdAt)}</span>
      </span>
      <span className={styles.result}>{compactionResult(compaction)}</span>
    </>
  )
  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        role="group"
        aria-label={COMPACTION_NAME}
        className={classNames(styles.call, styles.compaction, styles[state])}
        data-state={state}
      >
        {summary === null ? (
          line
        ) : (
          <>
            <button
              type="button"
              className={styles.callButton}
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((open) => !open)
              }}
            >
              {line}
            </button>
            <Collapse open={expanded}>
              <pre className={styles.summary} aria-label={`${COMPACTION_NAME} summary`}>
                <LinkedText text={summary} />
              </pre>
            </Collapse>
          </>
        )}
      </div>
    </div>
  )
})

/** One of the agent's working notes between tool calls, with its inline code and emphasis. */
const Narration = memo(function Narration({ narration, turnStart }: NarrationRow & TurnStartProps): React.JSX.Element {
  return (
    <p className={styles.narration} {...{ [TURN_START]: turnStart }}>
      <InlineMarkdown source={narration.text} />{' '}
      <span className={styles.narrationTime}>{clockTime(narration.createdAt)}</span>
    </p>
  )
})

/** A rule across the log with its label: "turn 2 · 11:20", "reopened · 09:14". */
const Divider = memo(function Divider({ label, turnStart }: DividerRow & TurnStartProps): React.JSX.Element {
  return (
    <div role="separator" aria-label={label} className={styles.divider} {...{ [TURN_START]: turnStart }}>
      <span className={styles.rule} />
      {label}
      <span className={styles.rule} />
    </div>
  )
})

/**
 * A GitHub notice (the link watcher, #682), in Main's list at the time it arrived (#715), laid out like a tool call
 * (#748): the slate dot of something that arrived, `GitHub` where the tool's name goes, the link's `label title` as
 * the argument, its time at the right and what changed under it, one row per link the notice is about (`githubNoticeLinks`)
 * — what a call's rows are to its multi-line output. It isn't clickable: there's nothing under it to open. It's
 * delivered to the agent as a message like any other; it just doesn't show in the chat as if it were your own words.
 */
const GithubNotice = memo(function GithubNotice({ message }: Pick<GithubNoticeRow, 'message'>): React.JSX.Element {
  const links = useMemo(() => githubNoticeLinks(message.body), [message.body])
  return (
    <>
      {links.map((link, index) => (
        <div key={`${String(index)} ${link.detail}`} className={styles.callGroup}>
          <div role="group" aria-label="GitHub" className={styles.call}>
            <span className={styles.callLine}>
              <Dot state={TaskIndicator.Done} label="GitHub notice" />
              <span className={styles.name}>GitHub</span>
              <span className={styles.argument} title={link.detail}>
                {link.detail}
              </span>
              <span className={styles.time}>{clockTime(message.createdAt)}</span>
            </span>
            {link.change !== '' && <span className={styles.result}>{link.change}</span>}
          </div>
        </div>
      ))}
    </>
  )
})

export interface ToolLogProps {
  readonly taskId: string
  readonly events: readonly ToolEvent[]
  /** The workspace root, so file arguments show relative to it. */
  readonly rootPath?: string | undefined
  /** Each call's permission line, by its `tool_use` id (`permissionLinesByToolUse`). None by default. */
  readonly permissions?: PermissionLines | undefined
  /** A turn to scroll to and highlight. */
  readonly focus?: TurnFocus | null | undefined
  /** Called once the log has scrolled to `focus`, so its owner can clear it. */
  readonly onFocusShown?: (() => void) | undefined
  /**
   * Whose log it is, in the Agents tab (P16, #536): a subagent's, by its `Agent` call's `tool_use` id. The task's own
   * agent's by default.
   */
  readonly agentId?: string | null | undefined
  /**
   * In the Agents tab: shows a subagent, by its `Agent` call's `tool_use` id. With it, a call that started a subagent
   * is a row that goes to that subagent (`AgentCall`); without it, it's a call like any other.
   */
  readonly onOpenAgent?: ((agentId: string) => void) | undefined
  /**
   * In the Agents tab: the agent's watchers (P16, #537). Each one that has ended is a row at the time it ended, and
   * the call that started one isn't a row. None by default.
   */
  readonly watchers?: LogWatchers | undefined
  /**
   * Main's GitHub notices (#682, #715): the task's messages left by the link watcher, each a row at the time it
   * arrived. None by default, and always none on a subagent's tab — a notice is only ever for the task's own agent.
   */
  readonly notices?: readonly Message[] | undefined
}

/**
 * A task's tool log: every tool call and working note of the task's own agent in order, with a divider where each turn
 * after the first starts. A subagent's calls and notes are on its own tab of the Agents tab instead: its `Agent` call
 * is one row here. A call a permission was decided about says so on its row. It keeps to the bottom as it grows, unless you've
 * scrolled up. Asked to show a turn, it scrolls to the turn's first row (its divider, or turn 1's first row) and
 * highlights it for a moment.
 *
 * In the Agents tab it's the list under an agent's tab, the same rows for a subagent's own calls and notes (`agentId`),
 * with the whole panel to itself, and with a row for each of the agent's watchers that has ended, at the time it ended
 * (`watchers`). Main's tab also has a row for each GitHub notice (#682), at the time it arrived (`notices`, #715):
 * it's delivered to the agent as a message like any other, but shows here, not in the chat.
 */
export function ToolLog({
  taskId,
  events,
  rootPath,
  permissions,
  focus,
  onFocusShown,
  agentId = null,
  onOpenAgent,
  watchers,
  notices,
}: ToolLogProps): React.JSX.Element {
  // The task's own log shows the contiguous tail and the older pages loaded onto it (#637): carried entries sent
  // whole however old, and a subagent's whole log once it loads, can sit far older in the window's log, and join the
  // list once their page does. A subagent's tab shows its own log whole.
  const eventsBefore = useGladeStore((state) =>
    agentId === null ? (state.historyTails[taskId]?.eventsBefore ?? null) : null,
  )
  const shown = useMemo(() => visibleLog(events, eventsBefore), [events, eventsBefore])
  const rows = useMemo(
    () => agentLogRows(shown, agentId, permissions, watchers, notices),
    [shown, agentId, permissions, watchers, notices],
  )
  // A permission line coming or going changes a row's height, as a new row changes the log's.
  const { ref, onScroll } = useStickToBottom(rows, taskId)
  // Older history loads as this scroll comes near the top (#637), the task's own log only: a subagent's loads whole
  // when its tab opens. The scroll keeps its place while the page goes in above.
  const store = useGladeStoreApi()
  const loadOlderOnScroll = useLoadOlderOnScroll(ref, taskId, agentId === null)
  const firstRow = rows[0]
  const firstId =
    firstRow === undefined
      ? null
      : firstRow.kind === AgentLogRowKind.Watcher
        ? firstRow.watcher.id
        : firstRow.kind === AgentLogRowKind.GithubNotice
          ? firstRow.message.id
          : rowEvent(firstRow).id
  useKeepScrollOnPrepend(ref, firstId, taskId, agentId === null, rows)
  const onLogScroll = useCallback(() => {
    onScroll()
    loadOlderOnScroll()
  }, [onScroll, loadOlderOnScroll])

  const highlighted = useRef<Highlight | null>(null)

  // Scrolls to and highlights the turn asked for. The highlight is a class set on the row directly, not React state,
  // since it's a moment's decoration of the DOM; it's taken off on a timer, which outlives `focus` being cleared.
  // A turn in history the log hasn't loaded yet (#637): older pages load until its first row is among them, then it
  // shows the same way — as many pages as it takes, until there's none older to bring in.
  useEffect(() => {
    if (focus === null || focus === undefined) return
    onFocusShown?.()
    const show = async (): Promise<void> => {
      for (;;) {
        const target = ref.current?.querySelector<HTMLElement>(`[${TURN_START}="${String(focus.turn)}"]`) ?? null
        if (target !== null) {
          const shown = target
          shown.scrollIntoView({ block: 'start' })

          const previous = highlighted.current
          if (previous !== null) {
            clearTimeout(previous.timer)
            previous.element.classList.remove(HIGHLIGHT_CLASS)
          }
          // Reading the layout restarts the animation when the same row is highlighted again.
          shown.getBoundingClientRect()
          shown.classList.add(HIGHLIGHT_CLASS)
          const timer = setTimeout(() => {
            shown.classList.remove(HIGHLIGHT_CLASS)
            highlighted.current = null
          }, FOCUS_HIGHLIGHT_MS)
          highlighted.current = { element: shown, timer }
          return
        }
        // The turn isn't loaded: it may be in history not loaded yet (#637). Stop when there's none older to bring
        // in, or a load failed; after one that answers, wait for the frame that shows its rows before looking again.
        const tail = store.getState().historyTails[taskId]
        if (tail?.hasOlderEvents !== true) return
        const loaded = await store
          .getState()
          .loadOlderHistory(taskId)
          .then(
            () => true,
            () => false,
          )
        if (!loaded) return
        // Wait for the frame that shows the page's rows before looking for the turn's first row again.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      }
    }
    void show()
  }, [focus, onFocusShown, ref, store, taskId])

  if (rows.length === 0) return <p className={styles.empty}>No tool calls yet.</p>

  const seen = new Set<number>()
  return (
    <ToolCallMenu taskId={taskId} rootPath={rootPath}>
      <div ref={ref} onScroll={onLogScroll} role="log" aria-label="Tool log" className={styles.scroller}>
        <div className={styles.log}>
          {rows.map((row) => {
            // A watcher or a GitHub notice is no part of a turn: the row after it may still be its turn's first.
            if (row.kind === AgentLogRowKind.Watcher) return <EndedWatcher key={row.watcher.id} watcher={row.watcher} />
            if (row.kind === AgentLogRowKind.GithubNotice) {
              return <GithubNotice key={row.message.id} message={row.message} />
            }
            const event = rowEvent(row)
            const turnStart = seen.has(event.turn) ? undefined : event.turn
            seen.add(event.turn)
            switch (row.kind) {
              case ToolEventKind.ToolCall:
                return onOpenAgent !== undefined && isSubagentTool(row.call.name) ? (
                  <AgentCall key={event.id} row={row} rootPath={rootPath} turnStart={turnStart} onOpen={onOpenAgent} />
                ) : (
                  <Call key={event.id} row={row} rootPath={rootPath} turnStart={turnStart} />
                )
              case ToolEventKind.Narration:
                return <Narration key={event.id} {...row} turnStart={turnStart} />
              case ToolEventKind.Divider:
                return <Divider key={event.id} {...row} turnStart={turnStart} />
              case ToolEventKind.Compaction:
                return <Compaction key={event.id} {...row} turnStart={turnStart} />
            }
          })}
        </div>
      </div>
    </ToolCallMenu>
  )
}

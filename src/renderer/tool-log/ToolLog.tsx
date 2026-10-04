import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ToolCallState, ToolEventKind, type ToolCallEvent, type ToolEvent } from '../../shared/domain'
import { isSubagentTool } from '../../shared/subagents'
import { agentCallResult, isRunning } from '../agents/agentsModel'
import { useElapsedNow } from '../agents/useElapsedNow'
import { clockTime } from '../chat/chatModel'
import { InlineMarkdown } from '../chat/Markdown'
import { useStickToBottom } from '../chat/useStickToBottom'
import { classNames } from '../components/classNames'
import { moduleClass } from '../components/moduleClass'
import { Collapse, Dot } from '../components'
import { LinkedText } from '../links'
import type { PermissionLines } from '../permissions/permissionLineModel'
import { PermissionLineView } from '../permissions/PermissionLine'
import {
  agentLogRows,
  argumentSummary,
  callIndicator,
  callStateLabel,
  COMPACTION_NAME,
  compactionArgument,
  compactionResult,
  resultSummary,
  rowIndicator,
  rowStateLabel,
  sameSubagentRow,
  showsCallState,
  showsResult,
  type CallRow,
  type CompactionRow,
  type DividerRow,
  type NarrationRow,
  type SubagentRow,
  type ToolLogRow,
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

/**
 * How a row is laid out: `compact` puts a call on one line, without its result, and tightens a note, as a subagent's
 * log in the Subagents tab does (docs/design/html/11-subagents.html).
 */
interface DensityProps {
  readonly compact?: boolean | undefined
}

interface CallProps extends TurnStartProps, DensityProps {
  readonly row: CallRow
  readonly rootPath: string | undefined
}

/**
 * Whether a call's row would render the same: its row, which is made anew each time the log's are, by what it holds.
 * The log's rows are memoised (#413): a long log is a thousand or more of them, and the log renders again with every
 * event, so only the rows whose own data changed render.
 */
function sameCall(a: CallProps, b: CallProps): boolean {
  return (
    sameSubagentRow(a.row, b.row) && a.rootPath === b.rootPath && a.turnStart === b.turnStart && a.compact === b.compact
  )
}

/** A call's first line: its dot, the tool's name, its argument and when it was made. */
function CallLine({ row, rootPath, compact = false }: Pick<CallProps, 'row' | 'rootPath' | 'compact'>): React.JSX.Element {
  const { call, name } = row
  return (
    <span className={styles.callLine}>
      <Dot state={rowIndicator(row)} label={rowStateLabel(row)} className={compact ? styles.smallDot : undefined} />
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
const Call = memo(function Call({ row, rootPath, turnStart, compact = false }: CallProps): React.JSX.Element {
  const { call, name, children, permission } = row
  const [expanded, setExpanded] = useState(false)
  const menuTarget = useToolCallMenuTarget(call)

  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        className={classNames(styles.call, showsCallState(row) && styles[call.state], compact && styles.compact)}
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
          <CallLine row={row} rootPath={rootPath} compact={compact} />
          {permission !== null && <PermissionLineView line={permission} className={styles.permission} />}
          {!compact && showsResult(row) && <span className={styles.result}>{resultSummary(call)}</span>}
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
      {children.length > 0 && (
        <div role="group" aria-label={`${name} subagent calls`} className={styles.children}>
          <SubagentRows rows={children} rootPath={rootPath} compact={compact} />
        </div>
      )}
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
 * and the first line of what it came to ("Done · 28m · Opened PR #511"). Clicking it goes to the subagent's own tab,
 * where what it did is, rather than opening the call's output; its context menu is a tool call's.
 */
const AgentCall = memo(function AgentCall({ row, rootPath, turnStart, onOpen }: AgentCallProps): React.JSX.Element {
  const { call, permission } = row
  const menuTarget = useToolCallMenuTarget(call)
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
        </button>
      </div>
    </div>
  )
}, sameAgentCall)

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
const Narration = memo(function Narration({
  narration,
  turnStart,
  compact = false,
}: NarrationRow & TurnStartProps & DensityProps): React.JSX.Element {
  return (
    <p className={classNames(styles.narration, compact && styles.compact)} {...{ [TURN_START]: turnStart }}>
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

export interface SubagentRowsProps extends DensityProps {
  readonly rows: readonly SubagentRow[]
  /** The workspace root, so file arguments show relative to it. */
  readonly rootPath: string | undefined
}

/** What a subagent did, in order: its tool calls (each opens its output) and its notes, laid out as the tool log's. */
export function SubagentRows({ rows, rootPath, compact }: SubagentRowsProps): React.JSX.Element {
  return (
    <>
      {rows.map((row) =>
        row.kind === ToolEventKind.ToolCall ? (
          <Call key={row.call.id} row={row} rootPath={rootPath} compact={compact} />
        ) : (
          <Narration key={row.narration.id} {...row} compact={compact} />
        ),
      )}
    </>
  )
}

function rowEvent(row: ToolLogRow): ToolEvent {
  switch (row.kind) {
    case ToolEventKind.ToolCall:
      return row.call
    case ToolEventKind.Narration:
      return row.narration
    case ToolEventKind.Divider:
      return row.divider
    case ToolEventKind.Compaction:
      return row.compaction
  }
}

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
}

/**
 * A task's tool log: every tool call and working note of the task's own agent in order, with a divider where each turn
 * after the first starts. A subagent's calls and notes are in the Subagents tab instead: its `Agent` call is one row
 * here. A call a permission was decided about says so on its row. It keeps to the bottom as it grows, unless you've
 * scrolled up. Asked to show a turn, it scrolls to the turn's first row (its divider, or turn 1's first row) and
 * highlights it for a moment.
 *
 * In the Agents tab it's the list under an agent's tab, the same rows for a subagent's own calls and notes (`agentId`),
 * with the whole panel to itself.
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
}: ToolLogProps): React.JSX.Element {
  const rows = useMemo(() => agentLogRows(events, agentId, permissions), [events, agentId, permissions])
  // A permission line coming or going changes a row's height, as a new row changes the log's.
  const { ref, onScroll } = useStickToBottom(rows, taskId)

  const highlighted = useRef<Highlight | null>(null)

  // Scrolls to and highlights the turn asked for. The highlight is a class set on the row directly, not React state,
  // since it's a moment's decoration of the DOM; it's taken off on a timer, which outlives `focus` being cleared.
  useEffect(() => {
    if (focus === null || focus === undefined) return
    onFocusShown?.()
    const target = ref.current?.querySelector<HTMLElement>(`[${TURN_START}="${String(focus.turn)}"]`)
    if (target === null || target === undefined) return
    target.scrollIntoView({ block: 'start' })

    const previous = highlighted.current
    if (previous !== null) {
      clearTimeout(previous.timer)
      previous.element.classList.remove(HIGHLIGHT_CLASS)
    }
    // Reading the layout restarts the animation when the same row is highlighted again.
    target.getBoundingClientRect()
    target.classList.add(HIGHLIGHT_CLASS)
    const timer = setTimeout(() => {
      target.classList.remove(HIGHLIGHT_CLASS)
      highlighted.current = null
    }, FOCUS_HIGHLIGHT_MS)
    highlighted.current = { element: target, timer }
  }, [focus, onFocusShown, ref])

  if (rows.length === 0) return <p className={styles.empty}>No tool calls yet.</p>

  const seen = new Set<number>()
  return (
    <ToolCallMenu taskId={taskId} rootPath={rootPath}>
      <div ref={ref} onScroll={onScroll} role="log" aria-label="Tool log" className={styles.scroller}>
        <div className={styles.log}>
          {rows.map((row) => {
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

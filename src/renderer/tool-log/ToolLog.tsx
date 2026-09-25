import { useEffect, useMemo, useRef, useState } from 'react'
import { ToolCallState, ToolEventKind, type ToolEvent } from '../../shared/domain'
import { clockTime } from '../chat/chatModel'
import { InlineMarkdown } from '../chat/Markdown'
import { useStickToBottom } from '../chat/useStickToBottom'
import { classNames } from '../components/classNames'
import { moduleClass } from '../components/moduleClass'
import { Collapse, Dot } from '../components'
import {
  argumentSummary,
  callIndicator,
  callStateLabel,
  COMPACTION_NAME,
  compactionArgument,
  compactionResult,
  resultSummary,
  parentLogRows,
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
 * One tool call: its name, argument, time and short result. Click it to see its full output; right-click it, or ⇧F10 on
 * it, for its context menu.
 */
function Call({ row, rootPath, turnStart, compact = false }: CallProps): React.JSX.Element {
  const { call, name, children } = row
  const [expanded, setExpanded] = useState(false)
  const menuTarget = useToolCallMenuTarget(call)

  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        className={classNames(styles.call, styles[call.state], compact && styles.compact)}
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
          <span className={styles.callLine}>
            <Dot
              state={callIndicator(call.state)}
              label={callStateLabel(call.state)}
              className={compact ? styles.smallDot : undefined}
            />
            <span className={styles.name}>{name}</span>
            <span className={styles.argument}>{argumentSummary(call, rootPath)}</span>
            <span className={styles.time}>{clockTime(call.createdAt)}</span>
          </span>
          {!compact && <span className={styles.result}>{resultSummary(call)}</span>}
        </button>
        <Collapse open={expanded}>
          <pre className={styles.output} aria-label={`${name} output`}>
            {call.output ?? (call.state === ToolCallState.Running ? 'No output yet.' : '')}
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
}

/** A compaction of the context, laid out like a tool call: "Compact  198k → 41k tokens". */
function Compaction({ compaction, turnStart }: CompactionRow & TurnStartProps): React.JSX.Element {
  const { state } = compaction
  return (
    <div className={styles.callGroup} {...{ [TURN_START]: turnStart }}>
      <div
        role="group"
        aria-label={COMPACTION_NAME}
        className={classNames(styles.call, styles.compaction, styles[state])}
        data-state={state}
      >
        <span className={styles.callLine}>
          <Dot state={callIndicator(state)} label={callStateLabel(state)} />
          <span className={styles.name}>{COMPACTION_NAME}</span>
          <span className={styles.argument}>{compactionArgument(compaction)}</span>
          <span className={styles.time}>{clockTime(compaction.createdAt)}</span>
        </span>
        <span className={styles.result}>{compactionResult(compaction)}</span>
      </div>
    </div>
  )
}

/** One of the agent's working notes between tool calls, with its inline code and emphasis. */
function Narration({
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
}

/** A rule across the log with its label: "turn 2 · 11:20", "reopened · 09:14". */
function Divider({ label, turnStart }: DividerRow & TurnStartProps): React.JSX.Element {
  return (
    <div role="separator" aria-label={label} className={styles.divider} {...{ [TURN_START]: turnStart }}>
      <span className={styles.rule} />
      {label}
      <span className={styles.rule} />
    </div>
  )
}

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
  /** A turn to scroll to and highlight. */
  readonly focus?: TurnFocus | null | undefined
  /** Called once the log has scrolled to `focus`, so its owner can clear it. */
  readonly onFocusShown?: (() => void) | undefined
}

/**
 * A task's tool log: every tool call and working note of the task's own agent in order, with a divider where each turn
 * after the first starts. A subagent's calls and notes are in the Subagents tab instead: its `Agent` call is one row
 * here. It keeps to the bottom as it grows, unless you've scrolled up. Asked to show a turn, it scrolls to the
 * turn's first row (its divider, or turn 1's first row) and highlights it for a moment.
 */
export function ToolLog({ taskId, events, rootPath, focus, onFocusShown }: ToolLogProps): React.JSX.Element {
  const rows = useMemo(() => parentLogRows(events), [events])
  const { ref, onScroll } = useStickToBottom(events, taskId)

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
                return <Call key={event.id} row={row} rootPath={rootPath} turnStart={turnStart} />
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

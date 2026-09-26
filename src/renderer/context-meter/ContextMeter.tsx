import { useState } from 'react'
import type { AutoCompact, Task } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { bindingHint, useBinding, type BindingHint } from '../commands/hooks'
import { Button, ButtonSize, Popover } from '../components'
import { classNames } from '../components/classNames'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import styles from './ContextMeter.module.css'
import { canCompact, useCompact } from './compact'
import { contextReading, type ContextReading } from './format'

/** The ring's radius, in the 16px icon's units. */
const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface ContextMeterViewProps {
  readonly usedTokens: number
  readonly windowTokens: number
  /** Where the SDK compacts automatically, as it last said (`Task.autoCompact`); its default until it has. */
  readonly autoCompact?: AutoCompact | null
}

/** "38%", as the meter and its popover show it. */
function percentLabel(reading: ContextReading): string {
  return `${String(reading.percent)}%`
}

/**
 * How full the context is: a small ring and "38% · 76k / 200k". The ring turns purple near the auto-compact threshold
 * (`NEAR_THRESHOLD_FRACTION`).
 */
export function ContextMeterView({
  usedTokens,
  windowTokens,
  autoCompact = null,
}: ContextMeterViewProps): React.JSX.Element {
  const reading = contextReading(usedTokens, windowTokens, autoCompact)
  const percent = percentLabel(reading)
  const amount = `${reading.used} / ${reading.window}`
  const arc = (reading.fraction * CIRCUMFERENCE).toFixed(1)
  return (
    <span
      className={classNames(styles.meter, reading.nearThreshold && styles.near)}
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={reading.percent}
      aria-valuetext={`${percent} · ${amount}`}
      title="Context used"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle className={styles.track} cx="8" cy="8" r={RADIUS} />
        <circle
          className={styles.arc}
          cx="8"
          cy="8"
          r={RADIUS}
          strokeDasharray={`${arc} ${CIRCUMFERENCE.toFixed(1)}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>
        <span className={styles.percent}>{percent}</span>
        <span className={styles.amount}> · {amount}</span>
      </span>
    </span>
  )
}

export interface ContextDetailsProps extends ContextMeterViewProps {
  /** Whether Compact now is offered: the agent is idle and has a session to compact. */
  readonly compactable: boolean
  readonly onCompact: () => void
  /** Compact context's keys, shown beside Compact now: its default (⌘⇧K) unless given the current ones. */
  readonly shortcut?: BindingHint
}

/** What the popover says of compacting: where the SDK does it on its own, if it does, and what compacting does. */
function compactingNote(reading: ContextReading): string {
  const what = 'Compacting replaces older turns with a summary for the agent; the full chat and tool log stay here.'
  return reading.threshold === null
    ? `Auto-compact is off in your Claude Code settings, so it compacts only when you ask. ${what}`
    : `Compacts automatically at ${String(reading.threshold.percent)}%. ${what}`
}

/**
 * The context meter's popover (docs/design/html/19-compaction.html): how full the context is, a bar with a marker
 * where the SDK compacts automatically (none while auto-compact is off), and Compact now.
 */
export function ContextDetails({
  usedTokens,
  windowTokens,
  autoCompact = null,
  compactable,
  onCompact,
  shortcut = bindingHint(WindowCommandId.CompactContext),
}: ContextDetailsProps): React.JSX.Element {
  const reading = contextReading(usedTokens, windowTokens, autoCompact)
  return (
    <div className={classNames(styles.details, reading.nearThreshold && styles.near)}>
      <div className={styles.header}>
        <span className={styles.title}>Context</span>
        <span className={styles.usage} data-testid="context-usage">
          <span className={styles.usagePercent}>{percentLabel(reading)}</span> · {reading.used} / {reading.window}
        </span>
      </div>
      <div className={styles.bar} aria-hidden>
        <div className={styles.fill} style={{ width: `${String(reading.fraction * 100)}%` }} />
        {reading.threshold !== null && (
          <div
            className={styles.marker}
            data-testid="auto-compact-marker"
            style={{ left: `${String(reading.threshold.fraction * 100)}%` }}
          />
        )}
      </div>
      <p className={styles.note}>{compactingNote(reading)}</p>
      <div className={styles.actions}>
        <Button
          size={ButtonSize.Small}
          disabled={!compactable}
          aria-keyshortcuts={shortcut.ariaKeyShortcuts}
          onClick={onCompact}
        >
          Compact now
        </Button>
        <span className={styles.shortcut}>{shortcut.label}</span>
      </div>
    </div>
  )
}

interface TaskContextMeterProps {
  readonly task: Task
}

function TaskContextMeter({ task }: TaskContextMeterProps): React.JSX.Element {
  const shortcut = useBinding(WindowCommandId.CompactContext)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const compact = useCompact()
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={styles.trigger}
        aria-label="Context"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((isOpen) => !isOpen)
        }}
      >
        <ContextMeterView
          usedTokens={task.contextUsedTokens}
          windowTokens={task.contextWindowTokens}
          autoCompact={task.autoCompact}
        />
      </button>
      <Popover
        label="Context"
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        className={styles.popover}
      >
        <ContextDetails
          usedTokens={task.contextUsedTokens}
          windowTokens={task.contextWindowTokens}
          autoCompact={task.autoCompact}
          compactable={canCompact(task)}
          onCompact={() => {
            setOpen(false)
            void compact(task.id)
          }}
          shortcut={shortcut}
        />
      </Popover>
    </>
  )
}

/**
 * The selected task's context meter, or nothing when no task is selected. Click it for the popover, with Compact now.
 * Must be used under a `ToastProvider`.
 */
export function ContextMeter(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  if (task === undefined) return null
  // Keyed by task, so the popover never carries over to another task.
  return <TaskContextMeter key={task.id} task={task} />
}

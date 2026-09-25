import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useState } from 'react'
import type { EpochMs, ToolEvent } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Collapse, Dot, Icon, IconSize } from '../components'
import {
  ContextMenu,
  subagentMenu,
  useContextMenu,
  useMenuCommands,
  type ContextMenuTargetProps,
} from '../context-menus'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import { SubagentRows, ToolCallMenu } from '../tool-log'
import {
  anyRunning,
  deriveSubagents,
  LatestLineKind,
  metaLine,
  statusIndicator,
  statusLabel,
  subagentLogText,
  SubagentStatus,
  tally,
  type LatestLine,
  type Subagent,
} from './subagentsModel'
import styles from './SubagentsTab.module.css'

/** How often a running subagent's elapsed time ticks. */
export const ELAPSED_REFRESH_MS = 1000

/** The line under a subagent's name: its latest tool call, the last thing it said (quoted), or what it came to. */
function Latest({ line }: { readonly line: LatestLine }): React.JSX.Element {
  switch (line.kind) {
    case LatestLineKind.ToolCall:
      return (
        <span className={styles.latest}>
          <span className={styles.toolName}>{line.name}</span>
          <span className={styles.toolArgument}>{line.argument}</span>
        </span>
      )
    case LatestLineKind.Said:
      return (
        <span className={styles.latest}>
          <span className={styles.text}>{`“${line.text}”`}</span>
        </span>
      )
    case LatestLineKind.Outcome:
      return (
        <span className={styles.latest}>
          <span className={styles.text}>{line.text}</span>
        </span>
      )
  }
}

interface RowProps {
  readonly subagent: Subagent
  readonly now: EpochMs
  readonly rootPath: string | undefined
  readonly expanded: boolean
  readonly onToggle: () => void
  /** What opens its context menu from its header. */
  readonly menuTarget: ContextMenuTargetProps
}

/**
 * One subagent: its dot, name, status, what it's doing and how long it has run. Click it to open its log below it
 * (in place of the latest line, which the log ends with); click again to close it.
 */
function SubagentRow({ subagent, now, rootPath, expanded, onToggle, menuTarget }: RowProps): React.JSX.Element {
  const { name, status, latest, log } = subagent
  return (
    <div
      role="group"
      aria-label={name}
      className={classNames(styles.row, styles[status], expanded && styles.expanded)}
      data-status={status}
    >
      <button type="button" className={styles.header} aria-expanded={expanded} onClick={onToggle} {...menuTarget}>
        <span className={styles.titleLine}>
          <Dot state={statusIndicator(status)} />
          <span className={styles.name}>{name}</span>
          <span className={styles.status}>{statusLabel(status)}</span>
          <span className={styles.chevron}>
            <Icon icon={expanded ? faChevronDown : faChevronRight} size={IconSize.Small} />
          </span>
        </span>
        {!expanded && latest !== null && <Latest line={latest} />}
        <span className={styles.meta}>{metaLine(subagent, now)}</span>
      </button>
      <Collapse open={expanded}>
        <div role="log" aria-label={`${name} log`} className={styles.log}>
          {log.length === 0 ? (
            <p className={styles.nothingYet}>Nothing yet.</p>
          ) : (
            <SubagentRows rows={log} rootPath={rootPath} compact />
          )}
        </div>
      </Collapse>
    </div>
  )
}

export interface SubagentsTabProps {
  readonly taskId: string
  readonly events: readonly ToolEvent[]
  /** The workspace root, so file arguments show relative to it. */
  readonly rootPath?: string | undefined
}

/**
 * The Subagents tab (docs/design/html/11-subagents.html): a tally of the task's subagents by status, then a row for
 * each, running ones first. A running subagent's elapsed time ticks. Rows open and close one at a time or several at
 * once; which are open is kept for as long as the tab shows the task. A row's context menu opens its log or copies it,
 * and stops it while it runs; the tool calls in an open log have their own.
 */
export function SubagentsTab({ taskId, events, rootPath }: SubagentsTabProps): React.JSX.Element {
  const subagents = useMemo(() => deriveSubagents(events, rootPath), [events, rootPath])
  const now = useNow(anyRunning(subagents) ? ELAPSED_REFRESH_MS : null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const menu = useContextMenu<string>()
  const { run, copy } = useMenuCommands()
  const stopSubagent = useGladeStore((state) => state.stopSubagent)

  if (subagents.length === 0) return <p className={styles.empty}>No subagents yet.</p>

  const toggle = (id: string): void => {
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const entries = (id: string) => {
    const subagent = subagents.find(({ call }) => call.id === id)
    if (subagent === undefined) return []
    return subagentMenu(
      { expanded: expanded.has(id) },
      {
        toggleLog: () => {
          toggle(id)
        },
        copyLog: () => {
          copy(subagentLogText(subagent, rootPath))
        },
        stop:
          subagent.status === SubagentStatus.Running
            ? () => {
                run(() => stopSubagent(taskId, subagent.call.toolUseId))
              }
            : null,
      },
    )
  }

  return (
    <ToolCallMenu taskId={taskId} rootPath={rootPath}>
      <div className={styles.scroller}>
        <div role="group" className={styles.tally} aria-label="Subagents by status">
          {tally(subagents).map(({ status, label }) => (
            <span key={status} className={styles.tallyPart} data-status={status}>
              <span className={classNames(styles.tallyDot, styles[status])} />
              {label}
            </span>
          ))}
        </div>
        {subagents.map((subagent) => (
          <SubagentRow
            key={subagent.call.id}
            subagent={subagent}
            now={now}
            rootPath={rootPath}
            expanded={expanded.has(subagent.call.id)}
            onToggle={() => {
              toggle(subagent.call.id)
            }}
            menuTarget={menu.targetProps(subagent.call.id)}
          />
        ))}
        <ContextMenu label="Subagent actions" state={menu} entries={entries} />
      </div>
    </ToolCallMenu>
  )
}

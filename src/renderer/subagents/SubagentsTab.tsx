import { faEye } from '@fortawesome/free-regular-svg-icons'
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useState } from 'react'
import type { EpochMs, ToolEvent, Watcher } from '../../shared/domain'
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
import { isLive, orderWatchers, subagentWatchers, WatcherRow, watchingLabel } from '../watchers'
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

/** How often a running subagent's elapsed time ticks, and its background work's. */
export const ELAPSED_REFRESH_MS = 1000

const NO_WATCHERS: readonly Watcher[] = []

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
  /** What it left running or scheduled (`subagentWatchers`), live ones first. */
  readonly watchers: readonly Watcher[]
  readonly now: EpochMs
  readonly rootPath: string | undefined
  readonly expanded: boolean
  readonly onToggle: () => void
  /** Stops one of its watchers. */
  readonly onStopWatcher: (id: string) => void
  /** What opens its context menu from its header. */
  readonly menuTarget: ContextMenuTargetProps
}

/**
 * One subagent: its dot, name, status, what it's doing and how long it has run, and an eye with a count while it has
 * something running in the background. Click it to open its log below it (in place of the latest line, which the log
 * ends with), and under that its background work, as the Watchers tab shows the task's own; click again to close it.
 */
function SubagentRow({
  subagent,
  watchers,
  now,
  rootPath,
  expanded,
  onToggle,
  onStopWatcher,
  menuTarget,
}: RowProps): React.JSX.Element {
  const { name, status, latest, log } = subagent
  const watching = watchers.filter(isLive).length
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
          {watching > 0 && (
            <span
              className={styles.watching}
              role="img"
              aria-label={watchingLabel(watching)}
              title={watchingLabel(watching)}
            >
              <Icon icon={faEye} size={IconSize.Small} />
              {watching}
            </span>
          )}
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
        {watchers.length > 0 && (
          <div role="group" aria-label={`${name} background work`} className={styles.background}>
            <p className={styles.backgroundLabel}>Background work</p>
            {watchers.map((watcher) => (
              <WatcherRow
                key={watcher.id}
                watcher={watcher}
                now={now}
                onStop={
                  isLive(watcher)
                    ? () => {
                        onStopWatcher(watcher.id)
                      }
                    : null
                }
              />
            ))}
          </div>
        )}
      </Collapse>
    </div>
  )
}

export interface SubagentsTabProps {
  readonly taskId: string
  readonly events: readonly ToolEvent[]
  /** The task's watchers: each subagent shows the ones it started. None by default. */
  readonly watchers?: readonly Watcher[] | undefined
  /** The workspace root, so file arguments show relative to it. */
  readonly rootPath?: string | undefined
}

/**
 * The Subagents tab (docs/design/html/11-subagents.html): a tally of the task's subagents by status, then a row for
 * each, running ones first. A running subagent's elapsed time ticks. Rows open and close one at a time or several at
 * once; which are open is kept for as long as the tab shows the task. A row's context menu opens its log or copies it,
 * and stops it while it runs; the tool calls in an open log have their own. What a subagent left running in the
 * background is under its log, with Stop while it's live.
 */
export function SubagentsTab({
  taskId,
  events,
  rootPath,
  watchers = NO_WATCHERS,
}: SubagentsTabProps): React.JSX.Element {
  const subagents = useMemo(() => deriveSubagents(events, rootPath), [events, rootPath])
  const ordered = useMemo(() => orderWatchers(watchers), [watchers])
  const now = useNow(anyRunning(subagents) || ordered.some(isLive) ? ELAPSED_REFRESH_MS : null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const menu = useContextMenu<string>()
  const { run, copy } = useMenuCommands()
  const stopSubagent = useGladeStore((state) => state.stopSubagent)
  const stopWatcher = useGladeStore((state) => state.stopWatcher)

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
            watchers={subagentWatchers(ordered, subagent.call.toolUseId)}
            now={now}
            rootPath={rootPath}
            expanded={expanded.has(subagent.call.id)}
            onToggle={() => {
              toggle(subagent.call.id)
            }}
            onStopWatcher={(id) => {
              run(() => stopWatcher(taskId, id))
            }}
            menuTarget={menu.targetProps(subagent.call.id)}
          />
        ))}
        <ContextMenu label="Subagent actions" state={menu} entries={entries} />
      </div>
    </ToolCallMenu>
  )
}

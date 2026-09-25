import { faSquare } from '@fortawesome/free-regular-svg-icons'
import { useMemo } from 'react'
import type { EpochMs, Watcher } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Dot, Icon, IconSize } from '../components'
import { useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import {
  isLive,
  kindLabel,
  metaLine,
  orderWatchers,
  outputLine,
  statusLabel,
  tally,
  watcherIndicator,
  whatLine,
} from './watchersModel'
import styles from './WatchersTab.module.css'

/** How often the tab's times tick while a watcher is live: its elapsed time and when it's due. */
export const WATCHERS_REFRESH_MS = 1000

interface RowProps {
  readonly watcher: Watcher
  readonly now: EpochMs
  /** Stops it; given while it's live. */
  readonly onStop: (() => void) | null
}

/**
 * One watcher: its dot, name, state and Stop while it's live; then its kind and what it runs, what it last reported
 * (or how it ended), and how many times it woke the agent and when.
 */
function WatcherRow({ watcher, now, onStop }: RowProps): React.JSX.Element {
  const output = outputLine(watcher)
  return (
    <div
      role="group"
      aria-label={watcher.label}
      className={classNames(styles.row, styles[watcher.state], isLive(watcher) && styles.live)}
      data-state={watcher.state}
      data-kind={watcher.kind}
    >
      <span className={styles.titleLine}>
        <Dot state={watcherIndicator(watcher.state)} />
        <span className={styles.name} title={watcher.label}>
          {watcher.label}
        </span>
        <span className={styles.status}>{statusLabel(watcher, now)}</span>
        {onStop !== null && (
          <button type="button" className={styles.stop} onClick={onStop} aria-label={`Stop ${watcher.label}`}>
            <Icon icon={faSquare} size={IconSize.Small} />
            Stop
          </button>
        )}
      </span>
      <span className={styles.line}>
        <span className={styles.kind}>{kindLabel(watcher.kind)}</span>
        <span className={styles.what} title={watcher.detail}>
          {whatLine(watcher)}
        </span>
      </span>
      {output !== null && (
        <span className={styles.line}>
          <span className={styles.lineLabel}>{output.kind}</span>
          <span className={styles.output} title={output.text}>
            {output.text}
          </span>
        </span>
      )}
      <span className={styles.meta}>{metaLine(watcher, now)}</span>
    </div>
  )
}

export interface WatchersTabProps {
  readonly taskId: string
  readonly watchers: readonly Watcher[]
}

/**
 * The Watchers tab (docs/design/html/27-watchers.html): a tally of what the task's agent left running or scheduled,
 * then a row for each, the live ones first. Glade builds none of them: the agent starts them with the SDK's own tools
 * (a `Monitor` watch, a background command, a wakeup, a cron job), and each row follows one. A live one has Stop.
 */
export function WatchersTab({ taskId, watchers }: WatchersTabProps): React.JSX.Element {
  const ordered = useMemo(() => orderWatchers(watchers), [watchers])
  const now = useNow(ordered.some(isLive) ? WATCHERS_REFRESH_MS : null)
  const stopWatcher = useGladeStore((state) => state.stopWatcher)
  const { run } = useMenuCommands()

  if (ordered.length === 0) return <p className={styles.empty}>Nothing running or scheduled.</p>

  return (
    <div className={styles.scroller}>
      <div role="group" className={styles.tally} aria-label="Watchers by state">
        {tally(ordered).map(({ group, label }) => (
          <span key={group} className={styles.tallyPart} data-group={group}>
            <span className={classNames(styles.tallyDot, styles[group])} />
            {label}
          </span>
        ))}
      </div>
      {ordered.map((watcher) => (
        <WatcherRow
          key={watcher.id}
          watcher={watcher}
          now={now}
          onStop={
            isLive(watcher)
              ? () => {
                  run(() => stopWatcher(taskId, watcher.id))
                }
              : null
          }
        />
      ))}
    </div>
  )
}

import { faEye, faSquare } from '@fortawesome/free-regular-svg-icons'
import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { WatcherState, type Watcher } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Icon } from '../components'
import { useMenuCommands } from '../context-menus'
import { LinkedText } from '../links'
import { useGladeStore } from '../store/react'
import { kindLabel, outputLine, whatLine } from '../watchers/watchersModel'
import type { AgentId } from './agentsModel'
import { agentWatchers, pinnedMetaLine, pinnedStatus } from './agentWatchersModel'
import { useDueNow } from './useDueNow'
import { useElapsedNow } from './useElapsedNow'
import styles from './AgentsTab.module.css'

/**
 * A pinned watcher's state: how long it has run ("Running · 5m"), or when it's due ("Due in 12m"). It keeps its own
 * clock, so as time passes it renders again by itself, and the card around it doesn't.
 */
function PinnedStatus({ watcher }: { readonly watcher: Watcher }): React.JSX.Element {
  const running = watcher.state === WatcherState.Running
  const elapsed = useElapsedNow(running ? watcher.startedAt : null)
  const due = useDueNow(watcher.state === WatcherState.Scheduled ? watcher.nextDueAt : null)
  return (
    <span className={classNames(styles.watcherState, running && styles.live)}>
      {pinnedStatus(watcher, running ? elapsed : due)}
    </span>
  )
}

interface PinnedWatcherProps {
  readonly taskId: string
  readonly id: string
}

/**
 * One watcher pinned under its agent's tool calls: the eye, what the agent called it, its state and Stop; then its
 * kind and what it runs, what it last reported, and how many times it woke the agent and when. One whose process runs
 * is on the live tint, with its state in blue; a wakeup or a cron job that's only scheduled is grey, and says when
 * it's due.
 *
 * It reads its own watcher from the store, which keeps a watcher's object until that watcher changes: a line it
 * reports or a wake renders this card, and no other.
 */
const PinnedWatcher = memo(function PinnedWatcher({ taskId, id }: PinnedWatcherProps): React.JSX.Element | null {
  const watcher = useGladeStore((state) => state.watchers[taskId]?.find((one) => one.id === id))
  const stopWatcher = useGladeStore((state) => state.stopWatcher)
  const { run } = useMenuCommands()
  if (watcher === undefined) return null
  const output = outputLine(watcher)
  const what = whatLine(watcher)
  return (
    <div
      role="group"
      aria-label={watcher.label}
      className={classNames(styles.watcher, watcher.state === WatcherState.Running && styles.live)}
      data-state={watcher.state}
      data-kind={watcher.kind}
    >
      <div className={styles.watcherHead}>
        <span className={styles.watcherEye}>
          <Icon icon={faEye} />
        </span>
        <span className={styles.watcherName} title={watcher.label}>
          {watcher.label}
        </span>
        <span className={styles.watcherSide}>
          <PinnedStatus watcher={watcher} />
          <button
            type="button"
            className={styles.stop}
            aria-label={`Stop ${watcher.label}`}
            onClick={() => {
              run(() => stopWatcher(taskId, id))
            }}
          >
            <Icon icon={faSquare} className={styles.stopIcon} />
            Stop
          </button>
        </span>
      </div>
      <div className={styles.watcherBody}>
        <div className={styles.watcherLine} title={watcher.detail}>
          <b>{kindLabel(watcher.kind)}</b>
          {what}
        </div>
        {output !== null && (
          <div className={styles.watcherLine} title={output.text}>
            <b>{output.kind}</b>
            <LinkedText text={output.text} />
          </div>
        )}
        <div className={styles.watcherLine}>{pinnedMetaLine(watcher)}</div>
      </div>
    </div>
  )
})

export interface PinnedWatchersProps {
  readonly taskId: string
  readonly agentId: AgentId
}

/**
 * What an agent is watching (P16, #537; `docs/design/html/52-agents-watcher.html`), pinned under its tool calls and
 * outside their scroll, so it's always in view: a card for each of its live watchers, in the order they started, under
 * a "Watching" label. A watcher whose process runs (a `Monitor` watch, a background command) and a wakeup or a cron job
 * that's only scheduled are pinned the same way. Once one finishes, fails or is stopped it leaves here, and is a row in
 * the agent's list at the time it ended (`ToolLog`). Nothing shows for an agent that's watching nothing.
 *
 * It reads only which watchers are pinned, so it renders when one starts or ends: what a watcher reports, each wake
 * and the passing time render that watcher's card alone.
 */
export const PinnedWatchers = memo(function PinnedWatchers({
  taskId,
  agentId,
}: PinnedWatchersProps): React.JSX.Element | null {
  const ids = useGladeStore(
    useShallow((state) => agentWatchers(state.watchers[taskId], agentId).pinned.map(({ id }) => id)),
  )
  if (ids.length === 0) return null
  return (
    <div role="group" aria-label="Watching" className={styles.pinned}>
      <p className={styles.pinnedLabel}>Watching</p>
      {ids.map((id) => (
        <PinnedWatcher key={id} taskId={taskId} id={id} />
      ))}
    </div>
  )
})

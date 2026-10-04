import { faEye } from '@fortawesome/free-regular-svg-icons'
import { useShallow } from 'zustand/react/shallow'
import { WatcherState, type Watcher } from '../../../shared/domain'
import { ChildKind } from '../../../shared/todoHub'
import { useMenuCommands } from '../../context-menus'
import { LinkedText } from '../../links'
import { useGladeStore } from '../../store/react'
import { NOW_REFRESH_MS, useNow } from '../../task-list/useNow'
import { StopButton, WATCHERS_REFRESH_MS } from '../../watchers/WatchersTab'
import {
  isLive,
  kindLabel,
  metaLine,
  OutputLineKind,
  reportLine,
  statusLabel,
  whatLine,
} from '../../watchers/watchersModel'
import { findWatcher } from './childIndex'
import { Tile, TileLine, TileTone, type KindTileProps } from './Tile'
import { makerName, STOP_CLASS, TileMeta } from './TileParts'

/** How a watcher's state reads: blue while its process runs, pink when its command failed, grey for the rest. */
function toneOf(state: WatcherState): TileTone {
  switch (state) {
    case WatcherState.Running:
      return TileTone.Live
    case WatcherState.Failed:
      return TileTone.Failed
    case WatcherState.Scheduled:
    case WatcherState.Suspended:
    case WatcherState.Finished:
    case WatcherState.Stopped:
      return TileTone.Plain
  }
}

/** Whether a watcher says when it's due (`Due in 20m`): one that's scheduled for a time. */
function saysWhenDue(watcher: Watcher): boolean {
  return watcher.state === WatcherState.Scheduled && watcher.nextDueAt !== null
}

/**
 * Where a watcher stands, in words: `Running`, `Finished`, `Due in 4m`. Only a scheduled one's words move with the
 * clock, so only it keeps one, and it alone renders as its time nears.
 */
function WatcherStatus({ watcher }: { readonly watcher: Watcher }): string {
  const now = useNow(saysWhenDue(watcher) ? NOW_REFRESH_MS : null)
  return statusLabel(watcher, now)
}

/**
 * How many times a watcher woke the agent and when, then its times, as the Watchers tab's row says them (`metaLine`):
 * `0 wakes · 3m 10s · since 14:02`. Only a running one's line moves with the clock (how long it has run), so only it
 * keeps one: the line renders every second by itself, and its tile doesn't.
 */
function WatcherMeta({ watcher }: { readonly watcher: Watcher }): string {
  const now = useNow(watcher.state === WatcherState.Running ? WATCHERS_REFRESH_MS : null)
  return metaLine(watcher, now)
}

/** The tooltip of the tag that says which subagent left a watcher running. */
function startedByTitle(name: string): string {
  return `Started by the subagent “${name}”`
}

/**
 * A watcher's tile, which shows what its row in the Watchers tab does: its label, where it stands and how long ago it
 * last woke the agent (else ended, else started); under them its kind and what it runs, its last report or how it
 * ended, and how many times it woke the agent and when. While it's live (running, scheduled or suspended) it has Stop.
 * On the live tint while its process runs; one that's only scheduled is grey, since nothing runs yet, and says when
 * it's due in place of its age; a failed one says so in pink. One a subagent left running is a tile of its own, tagged
 * with the subagent's name.
 */
export function WatcherTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const watcher = useGladeStore(useShallow((state) => findWatcher(state.watchers[taskId], childKey)))
  const by = useGladeStore((state) =>
    makerName(state.toolEvents[taskId], findWatcher(state.watchers[taskId], childKey)?.parentToolUseId ?? null),
  )
  const stopWatcher = useGladeStore((state) => state.stopWatcher)
  const { run } = useMenuCommands()
  if (watcher === undefined) return null
  const line = reportLine(watcher)
  return (
    <Tile
      kind={ChildKind.Watcher}
      name={watcher.label}
      icon={faEye}
      state={<WatcherStatus watcher={watcher} />}
      tone={toneOf(watcher.state)}
      at={saysWhenDue(watcher) ? null : (watcher.lastWokeAt ?? watcher.endedAt ?? watcher.startedAt)}
      live={watcher.state === WatcherState.Running}
      control={
        isLive(watcher) ? (
          <StopButton
            label={watcher.label}
            className={STOP_CLASS}
            onStop={() => {
              run(() => stopWatcher(taskId, watcher.id))
            }}
          />
        ) : undefined
      }
    >
      <TileLine label={kindLabel(watcher.kind)}>
        <span title={watcher.detail}>{whatLine(watcher)}</span>
      </TileLine>
      {line !== null && (
        <TileLine label={line.kind} failed={line.kind === OutputLineKind.End && watcher.state === WatcherState.Failed}>
          <span title={line.text}>
            <LinkedText text={line.text} />
          </span>
        </TileLine>
      )}
      <TileMeta by={by} byTitle={startedByTitle}>
        <WatcherMeta watcher={watcher} />
      </TileMeta>
    </Tile>
  )
}

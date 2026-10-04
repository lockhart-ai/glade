import { faEye } from '@fortawesome/free-regular-svg-icons'
import { useShallow } from 'zustand/react/shallow'
import { WatcherState, type Watcher } from '../../../shared/domain'
import { ChildKind } from '../../../shared/todoHub'
import { useGladeStore } from '../../store/react'
import { NOW_REFRESH_MS, useNow } from '../../task-list/useNow'
import { OutputLineKind, outputLine, statusLabel } from '../../watchers/watchersModel'
import { findWatcher } from './childIndex'
import { Tile, TileLine, TileTone, type KindTileProps } from './Tile'

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

/**
 * Where a watcher stands, in words: `Running`, `Finished`, `Due in 4m`. Only a scheduled one's words move with the
 * clock, so only it keeps one, and it alone renders as its time nears.
 */
function WatcherStatus({ watcher }: { readonly watcher: Watcher }): string {
  const counting = watcher.state === WatcherState.Scheduled && watcher.nextDueAt !== null
  const now = useNow(counting ? NOW_REFRESH_MS : null)
  return statusLabel(watcher, now)
}

/**
 * A watcher's tile: its label, where it stands and how long ago it last woke the agent (else ended, else started),
 * with its last report or how it ended under its name. On the live tint while its process runs; one that's only
 * scheduled is grey, since nothing runs yet. What it runs, its wakes and Stop are #499.
 */
export function WatcherTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const watcher = useGladeStore(useShallow((state) => findWatcher(state.watchers[taskId], childKey)))
  if (watcher === undefined) return null
  const line = outputLine(watcher)
  return (
    <Tile
      kind={ChildKind.Watcher}
      name={watcher.label}
      icon={faEye}
      state={<WatcherStatus watcher={watcher} />}
      tone={toneOf(watcher.state)}
      at={watcher.lastWokeAt ?? watcher.endedAt ?? watcher.startedAt}
      live={watcher.state === WatcherState.Running}
    >
      {line !== null && (
        <TileLine label={line.kind} failed={line.kind === OutputLineKind.End && watcher.state === WatcherState.Failed}>
          {line.text}
        </TileLine>
      )}
    </Tile>
  )
}

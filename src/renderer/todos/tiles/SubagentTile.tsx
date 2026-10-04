import { faSitemap } from '@fortawesome/free-solid-svg-icons'
import { useShallow } from 'zustand/react/shallow'
import { ChildKind } from '../../../shared/todoHub'
import { useGladeStore } from '../../store/react'
import { statusLabel, subagentName, subagentStatus, SubagentStatus } from '../../subagents/subagentsModel'
import { findSubagent } from './childIndex'
import { Tile, TileLine, TileTone, type KindTileProps } from './Tile'

/** How a subagent's state reads: blue while it runs, pink when it failed, grey for the rest. */
function toneOf(status: SubagentStatus): TileTone {
  switch (status) {
    case SubagentStatus.Running:
      return TileTone.Live
    case SubagentStatus.Error:
      return TileTone.Failed
    case SubagentStatus.Paused:
    case SubagentStatus.Done:
    case SubagentStatus.Interrupted:
      return TileTone.Plain
  }
}

/**
 * A subagent's tile: its name, where it stands and how long ago it last did anything; while it runs, on the live
 * tint with the one-line summary of what it's doing now under its name. Opening it in place to its log is #499.
 */
export function SubagentTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const subagent = useGladeStore(useShallow((state) => findSubagent(state.toolEvents[taskId], childKey)))
  if (subagent === undefined) return null
  const { call, lastActivityAt } = subagent
  const status = subagentStatus(call.state)
  const running = status === SubagentStatus.Running
  return (
    <Tile
      kind={ChildKind.Subagent}
      name={subagentName(call)}
      icon={faSitemap}
      state={statusLabel(status)}
      tone={toneOf(status)}
      at={lastActivityAt}
      live={running}
    >
      {running && call.progressSummary !== null && <TileLine>{call.progressSummary}</TileLine>}
    </Tile>
  )
}

import { faSitemap } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChildKind } from '../../../shared/todoHub'
import { ContextMenu, subagentMenu, useContextMenu, useMenuCommands } from '../../context-menus'
import { useGladeStore, useGladeStoreApi } from '../../store/react'
import type { GladeState } from '../../store/state'
import { SubagentLog } from '../../subagents/SubagentsTab'
import {
  statusLabel,
  subagentLogText,
  subagentName,
  subagentStatus,
  SubagentStatus,
  type Subagent,
} from '../../subagents/subagentsModel'
import { ToolCallMenu } from '../../tool-log'
import { findSubagent } from './childIndex'
import { rootPathOfTask, sameShownSubagent, selectSubagent, useSameSelector } from './subagentLog'
import { Tile, TileLine, TileTone, type KindTileProps } from './Tile'
import { TileOpened, WELL_CLASS } from './TileParts'

const NO_LOG: Subagent['log'] = []

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

interface OpenLogProps extends KindTileProps {
  /** The subagent's name, which names its log. */
  readonly name: string
}

/**
 * A subagent's log, in its opened tile: the Subagents tab's log (`SubagentLog`), in the tile's own box, with the tool
 * calls' context menu. Only an opened tile has one, and it reads its own subagent's rows from the store, so it renders
 * again when they change (a call made, a result, a permission decided) and not when anything else in the task does.
 */
function OpenLog({ taskId, childKey, name }: OpenLogProps): React.JSX.Element {
  const rootPath = useGladeStore((state) => rootPathOfTask(state, taskId))
  const subagent = useGladeStore(
    useSameSelector((state: GladeState) => selectSubagent(state, taskId, childKey), sameShownSubagent),
  )
  return (
    <ToolCallMenu taskId={taskId} rootPath={rootPath}>
      <SubagentLog name={name} log={subagent?.log ?? NO_LOG} rootPath={rootPath} className={WELL_CLASS} />
    </ToolCallMenu>
  )
}

/**
 * A subagent's tile, which does what its row in the Subagents tab does: its name, where it stands and how long ago it
 * last did anything; while it runs, on the live tint with the one-line summary of what it's doing now under its name.
 * Click it (or ↵ or Space on it) to open its log in place, and again to close it. Its context menu is the row's: open
 * or close its log, copy it, and stop it while it runs. What it left running isn't here: each watcher is a tile of its
 * own in the same todo (`WatcherTile`).
 */
export function SubagentTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const subagent = useGladeStore(useShallow((state) => findSubagent(state.toolEvents[taskId], childKey)))
  const [open, setOpen] = useState(false)
  const menu = useContextMenu<string>()
  const { targetProps } = menu
  const menuTarget = useMemo(() => targetProps(childKey), [targetProps, childKey])
  const store = useGladeStoreApi()
  const { run, copy } = useMenuCommands()
  if (subagent === undefined) return null
  const { call, lastActivityAt } = subagent
  const name = subagentName(call)
  const status = subagentStatus(call.state)
  const running = status === SubagentStatus.Running
  const toggle = (): void => {
    setOpen((shown) => !shown)
  }
  const entries = () =>
    subagentMenu(
      { expanded: open },
      {
        toggleLog: toggle,
        copyLog: () => {
          const state = store.getState()
          const shown = selectSubagent(state, taskId, childKey)
          if (shown !== undefined) copy(subagentLogText(shown, rootPathOfTask(state, taskId)))
        },
        stop: running
          ? () => {
              run(() => store.getState().stopSubagent(taskId, childKey))
            }
          : null,
      },
    )
  return (
    <div {...menuTarget} data-open={open ? '' : undefined}>
      <Tile
        kind={ChildKind.Subagent}
        name={name}
        icon={faSitemap}
        state={statusLabel(status)}
        tone={toneOf(status)}
        at={lastActivityAt}
        live={running}
        onOpen={toggle}
      >
        {running && call.progressSummary !== null && (
          <TileLine>
            <span title={call.progressSummary}>{call.progressSummary}</span>
          </TileLine>
        )}
        <TileOpened open={open}>
          <OpenLog taskId={taskId} childKey={childKey} name={name} />
        </TileOpened>
      </Tile>
      {menu.opened !== null && <ContextMenu label="Subagent actions" state={menu} entries={entries} />}
    </div>
  )
}

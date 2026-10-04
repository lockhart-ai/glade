import type { MouseEvent, ReactNode } from 'react'
import type { ToolEvent } from '../../../shared/domain'
import { UNKNOWN_SUBAGENT } from '../../changes/changesModel'
import { SubagentTag } from '../../changes/SubagentTag'
import { Collapse } from '../../components'
import { classNames } from '../../components/classNames'
import { subagentName } from '../../subagents/subagentsModel'
import { findSubagent } from './childIndex'
import tileStyles from './Tile.module.css'
import styles from './TileParts.module.css'

/** The class of the box a tile opens to in place (`.well`): a subagent's log, a commit's files. */
export const WELL_CLASS = styles.well

/** The class a commit's files have besides, in their box. */
export const FILES_CLASS = styles.files

/** The class that sizes the Watchers tab's Stop for a tile's first line. */
export const STOP_CLASS = styles.stop

/**
 * The name of the subagent that made one of a task's children (a watcher it left running, a commit), by the `tool_use`
 * id of its `Agent` call: null for a child the task's own agent made, and `Subagent` for one whose subagent the tool
 * log hasn't got, as the Changes tab says. Found in the log's index, so a tile's selector never walks the log.
 */
export function makerName(events: readonly ToolEvent[] | undefined, toolUseId: string | null): string | null {
  if (toolUseId === null) return null
  const maker = findSubagent(events, toolUseId)
  return maker === undefined ? UNKNOWN_SUBAGENT : subagentName(maker.call)
}

export interface TileMetaProps {
  /** The subagent that started it or made it: its tag comes after the line. None for the task's own. */
  readonly by: string | null
  /** The tag's tooltip, which says what the subagent did: `Started by the subagent “soak-login”`. */
  readonly byTitle: (name: string) => string
  readonly children: ReactNode
}

/**
 * A tile's last line, with the tag of the subagent that started it or made it after it (the Changes tab's tag): a
 * watcher's wakes and times, a commit's branch. The line is cut short before the tag is.
 */
export function TileMeta({ by, byTitle, children }: TileMetaProps): React.JSX.Element {
  return (
    <div className={classNames(tileStyles.line, styles.meta)}>
      <span className={styles.metaText}>{children}</span>
      {by !== null && <SubagentTag name={by} title={byTitle(by)} className={styles.by} />}
    </div>
  )
}

/** A click inside what a tile opened to is its own (a call's row, some text to select): it doesn't close the tile. */
function keepOpen(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

export interface TileOpenedProps {
  readonly open: boolean
  readonly children: ReactNode
}

/**
 * What a tile opens to in place, under its lines: it grows open and shrinks shut, and builds nothing while it's shut.
 * A click inside it, or in a menu it opened, isn't a click on the tile.
 */
export function TileOpened({ open, children }: TileOpenedProps): React.JSX.Element {
  return (
    <Collapse open={open}>
      {/* Not a control: it only keeps its own clicks from the tile around it. */}
      <div onClick={keepOpen}>{children}</div>
    </Collapse>
  )
}

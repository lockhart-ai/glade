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

/** The class of the box a tile opens to in place (`.well`): a commit's files. */
export const WELL_CLASS = styles.well

/** The class a commit's files have besides, in their box. */
export const FILES_CLASS = styles.files

/**
 * The name of the subagent that made one of a task's children (a commit), by the `tool_use` id of its `Agent` call:
 * null for a child the task's own agent made, and `Subagent` for one whose subagent the tool log hasn't got, as its
 * tag says. Found in the log's index, so a tile's selector never walks the log.
 */
export function makerName(events: readonly ToolEvent[] | undefined, toolUseId: string | null): string | null {
  if (toolUseId === null) return null
  const maker = findSubagent(events, toolUseId)
  return maker === undefined ? UNKNOWN_SUBAGENT : subagentName(maker)
}

export interface TileMetaProps {
  /** The subagent that made it: its tag comes after the line. None for the task's own. */
  readonly by: string | null
  /** The tag's tooltip, which says what the subagent did: `Made by the subagent “soak-login”`. */
  readonly byTitle: (name: string) => string
  /** Shows that subagent, from its tag; without it the tag is plain text. */
  readonly onOpenBy?: (() => void) | undefined
  readonly children: ReactNode
}

/**
 * A line of an opened tile with the tag of the subagent that made it after it (`SubagentTag`): a commit's
 * branch. The line is cut short before the tag is. The tag goes to the subagent's tab in the Agents tab (#537), when
 * the task's log has that subagent; else it's plain text.
 */
export function TileMeta({ by, byTitle, onOpenBy, children }: TileMetaProps): React.JSX.Element {
  return (
    <div className={classNames(tileStyles.line, styles.meta)}>
      <span className={styles.metaText}>{children}</span>
      {by !== null && <SubagentTag name={by} title={byTitle(by)} className={styles.by} onOpen={onOpenBy} />}
    </div>
  )
}

/** A click inside what a tile opened to is its own (a file's row, some text to select): it doesn't close the tile. */
function keepOpen(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

export interface TileOpenedProps {
  readonly open: boolean
  readonly children: ReactNode
}

/**
 * What a tile opens to in place, under its first line: it grows open and shrinks shut, and builds nothing while it's
 * shut. A click inside it isn't a click on the tile.
 */
export function TileOpened({ open, children }: TileOpenedProps): React.JSX.Element {
  return (
    <Collapse open={open}>
      {/* Not a control: it only keeps its own clicks from the tile around it. */}
      <div onClick={keepOpen}>{children}</div>
    </Collapse>
  )
}

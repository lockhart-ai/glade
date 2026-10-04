import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { EpochMs } from '../../../shared/domain'
import type { ChildKind } from '../../../shared/todoHub'
import { Icon, IconSize } from '../../components'
import { classNames } from '../../components/classNames'
import { tileLabel } from '../todoHubModel'
import { Age } from './Age'
import styles from './Tile.module.css'

/** How a tile's state reads, which colours it: blue is live, pink is what itself failed, grey is everything else. */
export enum TileTone {
  Plain = 'plain',
  Live = 'live',
  Failed = 'failed',
}

/** What every kind's tile is given: which task, and which of its children. It reads the child from the store itself. */
export interface KindTileProps {
  readonly taskId: string
  /** The child's own key within its kind (`ChildRef.key`): a file's path, a link's URL, a call's `tool_use` id. */
  readonly childKey: string
}

export interface TileProps {
  /** What it is, which names it to a screen reader ahead of its title (`Subagent: fix-501-ci`). */
  readonly kind: ChildKind
  /** Its title, as plain text: what it's called, and its accessible name. */
  readonly name: string
  /** The icon of what it is. */
  readonly icon: IconDefinition
  /** Something larger in the icon's place, e.g. an image file's thumbnail (#498); the icon unless given. */
  readonly media?: ReactNode
  /** A short code before its title, in blue mono type: a commit's short hash. None unless given. */
  readonly lead?: string | null
  /** A short tag after its title, in small mono type: a file's type, a link's number or domain. None unless given. */
  readonly tag?: string | null
  /** Where it stands, before its age: `Running`, `Done`, a commit's `+54 −0`. Nothing unless given. */
  readonly state?: ReactNode
  /** How its state reads (`TileTone`); plain unless given. */
  readonly tone?: TileTone
  /** When it last changed: its age, last on the first line. */
  readonly at: EpochMs
  /** Whether it's running now (a running subagent, a watcher whose process runs): the tile takes the live tint. */
  readonly live?: boolean
  /** Whether it's outlined, e.g. the file the Files tab shows (#498). */
  readonly selected?: boolean
  /**
   * What takes its age's place while the tile is under the pointer or has the focus: a file's or a link's icon
   * buttons (#498). Its age stays unless given.
   */
  readonly actions?: ReactNode
  /**
   * What a click on the tile does, and ↵ or Space while it has the focus: open a file, a subagent's log, a commit's
   * files (#498, #499). Nothing unless given. A click on a control inside the tile is the control's own.
   */
  readonly onOpen?: (() => void) | undefined
  /** Its own lines under the first (`TileLine`), and what it opens to in place, under its title across its width. */
  readonly children?: ReactNode
}

/** Whether a click landed on a control inside the tile (a button, a link), which answers it itself. */
function onControl({ target, currentTarget }: MouseEvent<HTMLElement>): boolean {
  if (!(target instanceof Element)) return false
  const control = target.closest('button, a')
  return control !== null && currentTarget.contains(control)
}

/**
 * One child of a todo in the hub (`docs/design/html/46-todo-hub.html`): its icon, its title with a tag, its state and
 * its age on one line, then any lines of its own. On `inner` with an `inner-border` outline, lighter under the pointer,
 * ringed while it has the focus, and on the `live` tint while it's running. It takes the focus by itself, so every
 * child is reachable with Tab. Each kind's tile (`FileTile`, `LinkTile`, `SubagentTile`, `WatcherTile`, `CommitTile`)
 * fills this in from its own child.
 */
export function Tile({
  kind,
  name,
  icon,
  media,
  lead = null,
  tag = null,
  state,
  tone = TileTone.Plain,
  at,
  live = false,
  selected = false,
  actions,
  onOpen,
  children,
}: TileProps): React.JSX.Element {
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onControl(event)) onOpen?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onOpen?.()
  }
  return (
    <div
      className={classNames(
        styles.tile,
        live && styles.live,
        selected && styles.selected,
        onOpen !== undefined && styles.openable,
        actions !== undefined && styles.acting,
      )}
      role="group"
      aria-label={tileLabel(kind, name)}
      tabIndex={0}
      data-kind={kind}
      data-live={live ? '' : undefined}
      {...(onOpen === undefined ? {} : { onClick, onKeyDown })}
    >
      <div className={classNames(styles.head, media !== undefined && styles.withMedia)}>
        <span className={classNames(styles.icon, media !== undefined && styles.media)} aria-hidden="true">
          {media ?? <Icon icon={icon} size={IconSize.Medium} />}
        </span>
        <div className={styles.title} title={name}>
          {lead !== null && <span className={styles.lead}>{lead}</span>}
          {name}
          {tag !== null && <span className={styles.tag}>{tag}</span>}
        </div>
        <div className={classNames(styles.right, tone === TileTone.Live && styles.liveText)}>
          {state !== undefined && (
            <>
              <span className={classNames(tone === TileTone.Failed && styles.failed)}>{state}</span>
              {' · '}
            </>
          )}
          <Age at={at} />
        </div>
        {actions !== undefined && <span className={styles.actions}>{actions}</span>}
      </div>
      {children !== undefined && children !== null && children !== false && (
        <div className={styles.body}>{children}</div>
      )}
    </div>
  )
}

export interface TileLineProps {
  /** A short label before the line, in a lighter grey: `last`, `end`. */
  readonly label?: string | undefined
  /** Whether the line says what failed: pink. */
  readonly failed?: boolean
  readonly children: ReactNode
}

/** One of a tile's own lines under its first: what a subagent is doing, what a watcher last said. One line, cut short. */
export function TileLine({ label, failed = false, children }: TileLineProps): React.JSX.Element {
  return (
    <div className={styles.line}>
      {label !== undefined && <b className={styles.lineLabel}>{label}</b>}
      <span className={classNames(failed && styles.failed)}>{children}</span>
    </div>
  )
}

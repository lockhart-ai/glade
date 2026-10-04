import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import type { EpochMs } from '../../../shared/domain'
import type { ChildKind } from '../../../shared/todoHub'
import { Icon, IconSize } from '../../components'
import { classNames } from '../../components/classNames'
import type { ContextMenuTargetProps } from '../../context-menus'
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
  /** What its tag says under the pointer: a file's path, a link's repository (#498). Nothing unless given. */
  readonly tagTitle?: string | undefined
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
  /** Whether it's faded back: a file that's gone, its title and its icon as faint as the rest (#498). */
  readonly muted?: boolean
  /** Whether it's still being worked out, e.g. a file's thumbnail on its way (#498): a capture waits for it. */
  readonly busy?: boolean
  /**
   * What takes its age's place while the tile is under the pointer or has the focus: a file's or a link's icon
   * buttons (#498). Its age stays unless given.
   */
  readonly actions?: ReactNode
  /**
   * Whether its actions stay in its age's place whatever has the pointer or the focus: while its menu is open (#498),
   * so the button the menu hangs from stays where it is, and takes the focus back once the menu closes.
   */
  readonly actionsPinned?: boolean
  /**
   * What opens its context menu, on a right-click or ⇧F10 while it (or a control inside it) has the focus
   * (`useContextMenu`'s `targetProps`, #498). It has no menu unless given.
   */
  readonly menuTarget?: ContextMenuTargetProps | undefined
  /** The tile's own element, e.g. to hand the focus back to it (#498). */
  readonly ref?: Ref<HTMLDivElement> | undefined
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
  tagTitle,
  state,
  tone = TileTone.Plain,
  at,
  live = false,
  selected = false,
  muted = false,
  busy = false,
  actions,
  actionsPinned = false,
  menuTarget,
  ref,
  onOpen,
  children,
}: TileProps): React.JSX.Element {
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onControl(event)) onOpen?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Its context menu's key first (⇧F10), from the tile or a control inside it.
    menuTarget?.onKeyDown(event)
    if (event.defaultPrevented || onOpen === undefined) return
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onOpen()
  }
  return (
    <div
      ref={ref}
      className={classNames(
        styles.tile,
        live && styles.live,
        selected && styles.selected,
        muted && styles.muted,
        onOpen !== undefined && styles.openable,
        actions !== undefined && styles.acting,
        actions !== undefined && actionsPinned && styles.pinned,
      )}
      role="group"
      aria-label={tileLabel(kind, name)}
      aria-current={selected || undefined}
      aria-busy={busy || undefined}
      tabIndex={0}
      data-kind={kind}
      data-live={live ? '' : undefined}
      {...(onOpen === undefined ? {} : { onClick })}
      {...(onOpen === undefined && menuTarget === undefined ? {} : { onKeyDown })}
      {...(menuTarget === undefined ? {} : { onContextMenu: menuTarget.onContextMenu })}
    >
      <div className={classNames(styles.head, media !== undefined && styles.withMedia)}>
        <span className={classNames(styles.icon, media !== undefined && styles.media)} aria-hidden="true">
          {media ?? <Icon icon={icon} size={IconSize.Medium} />}
        </span>
        <div className={styles.title} title={name}>
          {lead !== null && <span className={styles.lead}>{lead}</span>}
          {name}
          {tag !== null && (
            <span className={styles.tag} title={tagTitle}>
              {tag}
            </span>
          )}
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

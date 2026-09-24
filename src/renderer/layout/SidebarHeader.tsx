import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import type { ReactNode } from 'react'
import type { Workspace } from '../../shared/domain'
import { Icon } from '../components'
import { classNames } from '../components/classNames'
import { shortenHomePath } from '../paths'
import { BadgeTone } from '../workspace-switcher/switcherModel'
import { BadgeSize, WorkspaceBadge } from '../workspace-switcher/WorkspaceBadge'
import styles from './SidebarHeader.module.css'

/** The workspace switcher the header opens (`../workspace-switcher`). */
export interface SidebarHeaderSwitcher {
  /** Whether the switcher is open. */
  expanded: boolean
  /** Opens or closes the switcher, given the header's button to anchor its menu to. */
  onToggle: (trigger: HTMLElement) => void
}

export interface SidebarHeaderProps {
  /** The workspace the window shows; none before the first one is opened. */
  workspace?: Workspace
  /** The workspace's badge colour. Blue by default. */
  tone?: BadgeTone
  /** The switcher the workspace opens when clicked. Without one (before there's any workspace), it's inert. */
  switcher?: SidebarHeaderSwitcher
  /** The button that collapses the task list (see `PanelToggle`), where the window offers it. */
  collapseButton?: ReactNode
}

/**
 * The top of the sidebar: the workspace's initial in a badge, its name, and its root folder, with the switcher's
 * chevron, and the button that collapses the task list when the window offers it.
 */
export function SidebarHeader({
  workspace,
  tone = BadgeTone.Blue,
  switcher,
  collapseButton,
}: SidebarHeaderProps): React.JSX.Element {
  const content: ReactNode = (
    <>
      <WorkspaceBadge name={workspace?.name} tone={tone} size={BadgeSize.Large} />
      <span className={styles.text}>
        <span className={styles.name}>{workspace?.name ?? 'No workspace'}</span>
        <span className={styles.root}>
          {workspace === undefined ? 'Open a folder to begin' : shortenHomePath(workspace.rootPath)}
        </span>
      </span>
      <span className={styles.chevron}>
        <Icon icon={faChevronDown} />
      </span>
    </>
  )
  return (
    <section className={styles.header} aria-label="Workspace">
      {switcher === undefined ? (
        <div className={styles.workspace}>{content}</div>
      ) : (
        <button
          type="button"
          aria-label="Switch workspace"
          aria-haspopup="menu"
          aria-expanded={switcher.expanded}
          className={classNames(styles.workspace, styles.switch, switcher.expanded && styles.expanded)}
          onClick={(event) => {
            switcher.onToggle(event.currentTarget)
          }}
        >
          {content}
        </button>
      )}
      {collapseButton}
    </section>
  )
}

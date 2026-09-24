import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import type { ReactNode } from 'react'
import type { Workspace } from '../../shared/domain'
import { Icon } from '../components'
import { shortenHomePath } from '../paths'
import styles from './SidebarHeader.module.css'

export interface SidebarHeaderProps {
  /** The workspace the window shows; none before the first one is opened. */
  workspace?: Workspace
  /** The button that collapses the task list (see `PanelToggle`), where the window offers it. */
  collapseButton?: ReactNode
}

/**
 * The top of the sidebar: the workspace's initial in a badge, its name, and its root folder, with the switcher's
 * chevron and the button that collapses the task list. The chevron shows but does nothing yet (the switcher comes in
 * P7).
 */
export function SidebarHeader({ workspace, collapseButton }: SidebarHeaderProps): React.JSX.Element {
  return (
    <section className={styles.header} aria-label="Workspace">
      <div className={styles.workspace}>
        <span aria-hidden="true" className={styles.badge}>
          {workspace === undefined ? '?' : initial(workspace.name)}
        </span>
        <span className={styles.text}>
          <span className={styles.name}>{workspace?.name ?? 'No workspace'}</span>
          <span className={styles.root}>
            {workspace === undefined ? 'Open a folder to begin' : shortenHomePath(workspace.rootPath)}
          </span>
        </span>
        <span className={styles.chevron}>
          <Icon icon={faChevronDown} />
        </span>
      </div>
      {collapseButton}
    </section>
  )
}

/** The first character of a name, upper-cased, for the badge. */
function initial(name: string): string {
  return (Array.from(name)[0] ?? '?').toUpperCase()
}

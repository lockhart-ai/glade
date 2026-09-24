import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { useState, type ReactNode } from 'react'
import { AppCommandId, commandHint, WorkspaceCommandId } from '../../shared/commands'
import type { Task, Workspace } from '../../shared/domain'
import { Icon, IconSize, Menu, MenuAnchorKind, MenuEntryKind, type MenuEntry } from '../components'
import { classNames } from '../components/classNames'
import { SidebarHeader } from '../layout/SidebarHeader'
import { shortenHomePath } from '../paths'
import { useGladeStore } from '../store/react'
import { SettingsSection } from '../settings/sections'
import { selectSelectedWorkspace } from '../store/state'
import { badgeTone, describeStatus, workspaceStatus, WorkspaceStatusKind } from './switcherModel'
import { useWorkspaceActions } from './useWorkspaceActions'
import { WorkspaceBadge } from './WorkspaceBadge'
import styles from './WorkspaceSwitcher.module.css'

interface WorkspaceRowProps {
  workspace: Workspace
  workspaces: readonly Workspace[]
  tasks: Readonly<Record<string, Task>>
  shown: boolean
}

/** A workspace in the switcher: its badge, name and root, its status, and a check on the one shown. */
function WorkspaceRow({ workspace, workspaces, tasks, shown }: WorkspaceRowProps): React.JSX.Element {
  const status = workspaceStatus(Object.values(tasks), workspace.id)
  return (
    <>
      <WorkspaceBadge name={workspace.name} tone={badgeTone(workspaces, workspace.id)} />
      <span className={styles.text}>
        <span className={styles.name}>{workspace.name}</span>
        <span className={styles.root}>{shortenHomePath(workspace.rootPath)}</span>
      </span>
      <span
        className={classNames(styles.status, status.kind === WorkspaceStatusKind.NeedsYou && styles.needsYou)}
        data-status={status.kind}
      >
        {describeStatus(status)}
      </span>
      <span className={styles.check}>{shown && <Icon icon={faCheck} size={IconSize.Medium} />}</span>
    </>
  )
}

/**
 * The sidebar header, which opens the workspace switcher (`docs/design/html/14-workspace-switcher.html`): every
 * workspace, oldest first, with its status, then New workspace…, Open folder as workspace…, Workspace settings… and
 * Reveal root in Finder. Choosing a workspace switches to it, restoring its selection. Must be used under a
 * `ToastProvider`: failures show as toasts.
 */
export interface WorkspaceSwitcherProps {
  /** The button that collapses the task list, shown in the header beside the switcher. */
  collapseButton?: ReactNode
}

export function WorkspaceSwitcher({ collapseButton }: WorkspaceSwitcherProps): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  const workspaces = useGladeStore((state) => state.workspaces)
  const tasks = useGladeStore((state) => state.tasks)
  const openSettings = useGladeStore((state) => state.openSettings)
  const { add, open: switchTo, reveal } = useWorkspaceActions()
  // The header's button while the switcher is open; null while it's closed.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = anchor !== null

  const entries: MenuEntry[] = [
    { kind: MenuEntryKind.Heading, label: 'Workspaces' },
    ...workspaces.map((each): MenuEntry => ({
      kind: MenuEntryKind.Item,
      label: each.name,
      checked: each.id === workspace?.id,
      className: styles.row,
      content: (
        <WorkspaceRow workspace={each} workspaces={workspaces} tasks={tasks} shown={each.id === workspace?.id} />
      ),
      onSelect: () => {
        switchTo(each.id)
      },
    })),
    { kind: MenuEntryKind.Separator },
    {
      kind: MenuEntryKind.Item,
      label: 'New workspace…',
      shortcut: commandHint(AppCommandId.NewWorkspace),
      className: styles.action,
      onSelect: add,
    },
    {
      kind: MenuEntryKind.Item,
      label: 'Open folder as workspace…',
      shortcut: commandHint(AppCommandId.OpenFolder),
      className: styles.action,
      onSelect: add,
    },
    { kind: MenuEntryKind.Separator },
    {
      kind: MenuEntryKind.Item,
      label: 'Workspace settings…',
      shortcut: commandHint(WorkspaceCommandId.Settings),
      className: styles.action,
      onSelect: () => {
        openSettings(SettingsSection.Workspace)
      },
    },
    {
      kind: MenuEntryKind.Item,
      label: 'Reveal root in Finder',
      className: styles.action,
      onSelect: () => {
        if (workspace !== undefined) reveal(workspace.id)
      },
    },
  ]

  return (
    <>
      <SidebarHeader
        workspace={workspace}
        tone={workspace === undefined ? undefined : badgeTone(workspaces, workspace.id)}
        collapseButton={collapseButton}
        switcher={{
          expanded: open,
          onToggle: (trigger) => {
            setAnchor(open ? null : trigger)
          },
        }}
      />
      <Menu
        label="Workspaces"
        entries={entries}
        anchor={{ kind: MenuAnchorKind.Element, element: anchor }}
        open={open}
        onClose={() => {
          setAnchor(null)
        }}
        className={styles.menu}
      />
    </>
  )
}

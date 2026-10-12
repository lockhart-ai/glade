import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { useState, type ReactNode } from 'react'
import { AppCommandId } from '../../shared/commands'
import { UNTITLED_TASK_TITLE, type Task, type Workspace } from '../../shared/domain'
import { formatBinding } from '../../shared/keymap'
import { useKeymap } from '../commands/hooks'
import { Icon, IconSize, Menu, MenuAnchorKind, MenuEntryKind, useToast, type MenuEntry } from '../components'
import { classNames } from '../components/classNames'
import { SidebarHeader } from '../layout/SidebarHeader'
import { shortenHomePath } from '../paths'
import { useGladeStore } from '../store/react'
import { describeFailure } from '../store/hydrate'
import { SettingsSection } from '../settings/sections'
import { selectSelectedWorkspace } from '../store/state'
import {
  badgeTone,
  describeStatus,
  needsYouCount,
  switcherTitle,
  waitingTasks,
  workspaceStatus,
  WorkspaceStatusKind,
} from './switcherModel'
import { SwitcherAttentionPill } from './SwitcherAttentionPill'
import { useWorkspaceActions } from './useWorkspaceActions'
import { WorkspaceBadge } from './WorkspaceBadge'
import { MoreTasksRow, WaitingTaskRow } from './WaitingTaskRow'
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
  const selectTask = useGladeStore((state) => state.selectTask)
  const { add, open: switchTo, reveal } = useWorkspaceActions()
  const toast = useToast()
  const keymap = useKeymap()
  // The header's button while the switcher is open; null while it's closed.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = anchor !== null

  // Opens a waiting task: switches workspace and selects it in one step (the same `selectTask` the menu bar
  // popover's own rows use), reported as a toast on failure like every other switcher action.
  const openTask = (taskId: string): void => {
    selectTask(taskId).catch((error: unknown) => {
      toast.show({ message: describeFailure(error) })
    })
  }

  // Each workspace's own row, then — only while the menu is open, so a closed switcher costs no more than it does
  // today (CLAUDE.md, Performance) — its waiting tasks nested under it, newest first, capped at
  // `WAITING_TASKS_SHOWN` with a "+N more" row past that. Every row is its own flat `MenuEntry`, so the menu's
  // existing Up/Down/Enter navigation reaches task rows for free.
  const taskList = open ? Object.values(tasks) : []
  const workspaceEntries: MenuEntry[] = workspaces.flatMap((each): MenuEntry[] => {
    const shown = each.id === workspace?.id
    const workspaceEntry: MenuEntry = {
      kind: MenuEntryKind.Item,
      label: each.name,
      checked: shown,
      className: styles.row,
      content: <WorkspaceRow workspace={each} workspaces={workspaces} tasks={tasks} shown={shown} />,
      onSelect: () => {
        switchTo(each.id)
      },
    }
    if (!open) return [workspaceEntry]
    const { shown: waiting, moreCount } = waitingTasks(taskList, each.id)
    const taskEntries: MenuEntry[] = waiting.map((task) => {
      // The row itself reads its own title from the store (`WaitingTaskRow`); this just names the entry for the
      // button's accessible name and typeahead, from the `tasks` map already in hand.
      const title = tasks[task.taskId]?.title
      return {
        kind: MenuEntryKind.Item,
        label: title === undefined || title === '' ? UNTITLED_TASK_TITLE : title,
        className: styles.waitingRow,
        content: <WaitingTaskRow taskId={task.taskId} />,
        onSelect: () => {
          openTask(task.taskId)
        },
      }
    })
    const moreEntry: MenuEntry[] =
      moreCount === 0
        ? []
        : [
            {
              kind: MenuEntryKind.Item,
              label: `+${String(moreCount)} more in ${each.name}`,
              className: styles.waitingRow,
              content: <MoreTasksRow count={moreCount} workspaceName={each.name} />,
              onSelect: () => {
                switchTo(each.id)
              },
            },
          ]
    return [workspaceEntry, ...taskEntries, ...moreEntry]
  })

  const entries: MenuEntry[] = [
    { kind: MenuEntryKind.Heading, label: 'Workspaces' },
    ...workspaceEntries,
    { kind: MenuEntryKind.Separator },
    {
      kind: MenuEntryKind.Item,
      label: 'New workspace…',
      shortcut: formatBinding(AppCommandId.NewWorkspace, keymap),
      className: styles.action,
      onSelect: add,
    },
    {
      kind: MenuEntryKind.Item,
      label: 'Open folder as workspace…',
      shortcut: formatBinding(AppCommandId.OpenFolder, keymap),
      className: styles.action,
      onSelect: add,
    },
    { kind: MenuEntryKind.Separator },
    {
      kind: MenuEntryKind.Item,
      label: 'Workspace settings…',
      shortcut: formatBinding(AppCommandId.Settings, keymap),
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
        pill={<SwitcherAttentionPill />}
        switcher={{
          expanded: open,
          onToggle: (trigger) => {
            setAnchor(open ? null : trigger)
          },
          title: switcherTitle(needsYouCount(Object.values(tasks), workspaces)),
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

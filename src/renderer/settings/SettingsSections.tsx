import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { useState, type ReactNode } from 'react'
import { Effort, PermissionMode } from '../../shared/domain'
import { EFFORT_NAMES, MODEL_OPTIONS, modelName } from '../../shared/models'
import type { Settings, SettingsPatch } from '../../shared/settings'
import {
  Button,
  ButtonSize,
  Icon,
  IconSize,
  Input,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  Placement,
  Segmented,
  Toggle,
  type MenuEntry,
  type SegmentedOption,
} from '../components'
import { shortenHomePath } from '../paths'
import { describeFailure } from '../store/hydrate'
import { selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import styles from './SettingsDialog.module.css'

interface SettingRowProps {
  /** The setting's name. */
  name: string
  /** A line on what it does. */
  description: ReactNode
  /** The control that changes it. */
  children: ReactNode
}

/** One setting: its name and a line on what it does, and the control that changes it on the right. */
function SettingRow({ name, description, children }: SettingRowProps): React.JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowDescription}>{description}</span>
      </div>
      {children}
    </div>
  )
}

interface IntroProps {
  children: ReactNode
}

/** The line under a section's heading. */
function Intro({ children }: IntroProps): React.JSX.Element {
  return <p className={styles.intro}>{children}</p>
}

/** The settings, and a way to change some of them, saved at once. */
function useSettings(): [Settings, (patch: SettingsPatch) => void] {
  const settings = useGladeStore((state) => state.settings)
  const updateSettings = useGladeStore((state) => state.updateSettings)
  return [settings, (patch) => void updateSettings(patch)]
}

const EFFORT_OPTIONS: readonly SegmentedOption<Effort>[] = Object.values(Effort).map((effort) => ({
  value: effort,
  label: EFFORT_NAMES[effort],
}))

/**
 * What the agent may do without asking, as the design's Permissions setting offers it: Ask first is the ask mode
 * (`PermissionMode.AskBeforeEdits`), Allow all is Allow all, and Allow edits isn't a mode yet, so it's disabled
 * (`docs/decisions.md`, "Per-call permission review").
 */
export enum Permission {
  AskFirst = 'ask_first',
  AllowEdits = 'allow_edits',
  AllowAll = 'allow_all',
}

const PERMISSION_OPTIONS: readonly SegmentedOption<Permission>[] = [
  { value: Permission.AskFirst, label: 'Ask first' },
  { value: Permission.AllowEdits, label: 'Allow edits', disabled: true },
  { value: Permission.AllowAll, label: 'Allow all' },
]

/** The option a permission mode shows as. */
function permissionOf(mode: PermissionMode): Permission {
  switch (mode) {
    case PermissionMode.AllowAll:
      return Permission.AllowAll
    case PermissionMode.AskBeforeEdits:
      return Permission.AskFirst
  }
}

/** The permission mode an option stands for; null for Allow edits, which can't be chosen. */
export function permissionModeOf(permission: Permission): PermissionMode | null {
  switch (permission) {
    case Permission.AskFirst:
      return PermissionMode.AskBeforeEdits
    case Permission.AllowAll:
      return PermissionMode.AllowAll
    case Permission.AllowEdits:
      return null
  }
}

interface ModelPickerProps {
  value: string
  onChoose: (model: string) => void
}

/** The default model: a button naming it, which opens a menu of the models with it checked. */
function ModelPicker({ value, onChoose }: ModelPickerProps): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const entries: MenuEntry[] = MODEL_OPTIONS.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.name,
    checked: option.id === value,
    onSelect: () => {
      onChoose(option.id)
    },
  }))
  return (
    <>
      <button
        type="button"
        aria-label={`Model: ${modelName(value)}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        className={styles.select}
        onClick={(event) => {
          setAnchor(event.currentTarget)
        }}
      >
        {modelName(value)}
        <Icon icon={faChevronDown} size={IconSize.Small} />
      </button>
      <Menu
        label="Model"
        entries={entries}
        anchor={{ kind: MenuAnchorKind.Element, element: anchor, placement: Placement.BottomEnd }}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
      />
    </>
  )
}

/** Nothing here yet: every app-wide setting so far belongs to another section. */
export function GeneralSection(): React.JSX.Element {
  return <Intro>Nothing to set here yet.</Intro>
}

/** The defaults for new tasks, and what the agent keeps current (the design's section). */
export function AgentSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  return (
    <>
      <Intro>Defaults for new tasks. Each task can change these from its input bar. Changes save automatically.</Intro>
      <SettingRow name="Model" description="Used for new tasks.">
        <ModelPicker
          value={settings.defaultModel}
          onChoose={(defaultModel) => {
            update({ defaultModel })
          }}
        />
      </SettingRow>
      <SettingRow name="Effort" description="How long the agent thinks before acting.">
        <Segmented
          label="Effort"
          options={EFFORT_OPTIONS}
          value={settings.defaultEffort}
          onChange={(defaultEffort) => {
            update({ defaultEffort })
          }}
        />
      </SettingRow>
      <SettingRow name="Permissions" description="What the agent may do without asking.">
        <Segmented
          label="Permissions"
          options={PERMISSION_OPTIONS}
          value={permissionOf(settings.defaultPermissionMode)}
          onChange={(permission) => {
            const defaultPermissionMode = permissionModeOf(permission)
            if (defaultPermissionMode !== null) update({ defaultPermissionMode })
          }}
        />
      </SettingRow>
      <SettingRow
        name="Status summary"
        description="Rewrite the task's status after every turn. Shown in the header and task list."
      >
        <Toggle
          label="Status summary"
          checked={settings.statusSummary}
          onChange={(statusSummary) => {
            update({ statusSummary })
          }}
        />
      </SettingRow>
      <SettingRow name="Task titles" description="Generate the title from the first message.">
        <Toggle
          label="Task titles"
          checked={settings.taskTitles}
          onChange={(taskTitles) => {
            update({ taskTitles })
          }}
        />
      </SettingRow>
    </>
  )
}

/** Whether a reply in a task you aren't viewing notifies, and whether it makes a sound. */
export function NotificationsSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  return (
    <>
      <Intro>Focus and Do Not Disturb are up to macOS. Changes save automatically.</Intro>
      <SettingRow name="Notifications" description="Notify a reply in a task you aren't viewing.">
        <Toggle
          label="Notifications"
          checked={settings.notifications}
          onChange={(notifications) => {
            update({ notifications })
          }}
        />
      </SettingRow>
      <SettingRow name="Sound" description="Play a sound with each notification.">
        <Toggle
          label="Sound"
          checked={settings.notificationSound}
          disabled={!settings.notifications}
          onChange={(notificationSound) => {
            update({ notificationSound })
          }}
        />
      </SettingRow>
    </>
  )
}

/** Glade has one theme, so there's nothing to choose. */
export function AppearanceSection(): React.JSX.Element {
  return <Intro>Glade has one theme, dark. Nothing to change here yet.</Intro>
}

/** The plugin API is for later, so there are none to show. */
export function PluginsSection(): React.JSX.Element {
  return <Intro>No plugins installed.</Intro>
}

/** The workspace you're in: its name and root folder. Changing the root moves nothing on disk. */
export function WorkspaceSection(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  const updateWorkspace = useGladeStore((state) => state.updateWorkspace)
  const chooseFolder = useGladeStore((state) => state.chooseFolder)
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (workspace === undefined) return <></>
  const name = draft?.id === workspace.id ? draft.name : workspace.name

  const save = async (change: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await change()
    } catch (failure) {
      setError(describeFailure(failure))
    }
  }

  const rename = (): void => {
    setDraft(null)
    const trimmed = name.trim()
    // A blank name goes back to the one it had: a workspace can't be called nothing.
    if (trimmed === '' || trimmed === workspace.name) return
    void save(() => updateWorkspace(workspace.id, { name: trimmed }))
  }

  const changeRoot = async (): Promise<void> => {
    const rootPath = await chooseFolder()
    if (rootPath === null || rootPath === workspace.rootPath) return
    await save(() => updateWorkspace(workspace.id, { rootPath }))
  }

  return (
    <>
      <Intro>This workspace&apos;s name and root folder. Changes save automatically.</Intro>
      <SettingRow name="Name" description="Shown in the sidebar and the workspace switcher.">
        <Input
          label="Workspace name"
          className={styles.nameField}
          value={name}
          onChange={(event) => {
            setDraft({ id: workspace.id, name: event.target.value })
          }}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') rename()
          }}
        />
      </SettingRow>
      <SettingRow
        name="Root folder"
        description={
          <>
            Tasks run here, with its CLAUDE.md. Nothing on disk moves.
            <span className={styles.path} title={workspace.rootPath}>
              {shortenHomePath(workspace.rootPath)}
            </span>
          </>
        }
      >
        <Button size={ButtonSize.Small} onClick={() => void changeRoot()}>
          Change…
        </Button>
      </SettingRow>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  )
}

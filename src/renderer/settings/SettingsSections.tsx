import { faArrowsRotate, faChevronDown, faPuzzlePiece, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState, type ReactNode } from 'react'
import { Effort, PermissionMode } from '../../shared/domain'
import { LoginState } from '../../shared/login'
import { isStoppedLoggedOut } from '../../shared/taskError'
import {
  EFFORT_NAMES,
  effortFallbackNotice,
  effortFor,
  effortsOf,
  findModel,
  modelName,
  modelOptions,
  type ModelChoice,
} from '../../shared/models'
import {
  isGranted,
  PLUGIN_CAPABILITY_LABELS,
  PluginStatus,
  type InstalledPlugin,
  type PluginCapability,
  type PluginSelectSetting,
  type PluginSetting,
  type ValidPlugin,
} from '../../shared/plugins'
import type { Settings, SettingsPatch } from '../../shared/settings'
import {
  Button,
  ButtonSize,
  ButtonVariant,
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
  useToast,
} from '../components'
import { classNames } from '../components/classNames'
import { shortenHomePath } from '../paths'
import { describeFailure } from '../store/hydrate'
import { selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import { accountView, loginRowDescription, offersLogin } from './accountModel'
import styles from './SettingsDialog.module.css'

export interface SettingRowProps {
  /** The setting's name. */
  name: string
  /** A line on what it does. */
  description: ReactNode
  /** The control that changes it. */
  children: ReactNode
}

/** One setting: its name and a line on what it does, and the control that changes it on the right. */
export function SettingRow({ name, description, children }: SettingRowProps): React.JSX.Element {
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

export interface IntroProps {
  children: ReactNode
}

/** The line under a section's heading. */
export function Intro({ children }: IntroProps): React.JSX.Element {
  return <p className={styles.intro}>{children}</p>
}

/** The settings, and a way to change some of them, saved at once. */
export function useSettings(): [Settings, (patch: SettingsPatch) => void] {
  const settings = useGladeStore((state) => state.settings)
  const updateSettings = useGladeStore((state) => state.updateSettings)
  return [settings, (patch) => void updateSettings(patch)]
}

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
  /** The models it offers. */
  models: readonly ModelChoice[]
  value: string
  onChoose: (model: string) => void
}

/** The default model: a button naming it, which opens a menu of the models with it checked. */
function ModelPicker({ models, value, onChoose }: ModelPickerProps): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const selected = findModel(models, value)?.id ?? value
  const entries: MenuEntry[] = modelOptions(models, value).map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.name,
    checked: option.id === selected,
    onSelect: () => {
      onChoose(option.id)
    },
  }))
  return (
    <>
      <button
        type="button"
        aria-label={`Model: ${modelName(models, value)}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        className={styles.select}
        onClick={(event) => {
          setAnchor(event.currentTarget)
        }}
      >
        {modelName(models, value)}
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

/**
 * Settings › General's Log in (#409), under the account while Claude Code isn't signed in or a lost login stops a
 * task: the logged-out card's login, run for no task in particular, so it retries none. While it runs, Cancel stops
 * it.
 */
function LoginRow(): React.JSX.Element {
  const login = useGladeStore((state) => state.login)
  const startLogin = useGladeStore((state) => state.startLogin)
  const cancelLogin = useGladeStore((state) => state.cancelLogin)
  const [error, setError] = useState<string | null>(null)

  const attempt = (action: () => Promise<void>): void => {
    setError(null)
    action().catch((failure: unknown) => {
      setError(describeFailure(failure))
    })
  }

  return (
    <>
      <SettingRow name="Log in" description={loginRowDescription(login)}>
        {login.state === LoginState.Waiting ? (
          <span className={styles.buttons}>
            <Button size={ButtonSize.Small} disabled>
              Waiting for the browser…
            </Button>
            <Button
              variant={ButtonVariant.Ghost}
              size={ButtonSize.Small}
              onClick={() => {
                attempt(cancelLogin)
              }}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            size={ButtonSize.Small}
            onClick={() => {
              attempt(() => startLogin(null))
            }}
          >
            Log in
          </Button>
        )}
      </SettingRow>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  )
}

/**
 * Glade in the macOS menu bar (`docs/design/html/29-menu-bar.html`), then the account the tasks run on and bill to, as
 * Claude Code last reported it (`docs/design/html/21-settings.html`). Claude Code owns the login; while it isn't signed
 * in, or a lost login stops a task, Log in runs Claude Code's own (#409).
 */
export function GeneralSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  const account = useGladeStore((state) => state.accountStatus.account)
  const loggedOut = useGladeStore((state) => Object.values(state.tasks).some(isStoppedLoggedOut))
  const now = useNow()
  const view = accountView(account, now)
  return (
    <>
      <Intro>Changes save automatically.</Intro>
      <SettingRow
        name="Show Glade in the menu bar"
        description="An icon with what needs you and what's working; click it for the list."
      >
        <Toggle
          label="Show Glade in the menu bar"
          checked={settings.showInMenuBar}
          onChange={(showInMenuBar) => {
            update({ showInMenuBar })
          }}
        />
      </SettingRow>
      <section aria-labelledby="settings-account" className={styles.group}>
        <h3 id="settings-account" className={styles.groupHeading}>
          Account
        </h3>
        <Intro>{view.intro}</Intro>
        {view.rows.map((row) => (
          <SettingRow key={row.name} name={row.name} description={row.description}>
            <span className={styles.value} title={row.value}>
              {row.value}
            </span>
          </SettingRow>
        ))}
        {offersLogin(account, loggedOut) && <LoginRow />}
        {view.readLine !== null && <p className={styles.note}>{view.readLine}</p>}
      </section>
    </>
  )
}

/** The defaults for new tasks, and what the agent keeps current (the design's section). */
export function AgentSection(): React.JSX.Element {
  const [settings, update] = useSettings()
  const models = useGladeStore((state) => state.models)
  const toast = useToast()
  // The effort levels the default model supports: none hides the setting.
  const efforts = effortsOf(models, settings.defaultModel)
  /** Changes the default model, and the default effort with it when the new model doesn't support it, saying so. */
  const chooseModel = (defaultModel: string): void => {
    const { defaultEffort } = settings
    const effort = effortFor(models, defaultModel, defaultEffort)
    update(effort === defaultEffort ? { defaultModel } : { defaultModel, defaultEffort: effort })
    const notice = effortFallbackNotice(models, defaultModel, defaultEffort, effort)
    if (notice !== null) toast.show({ message: notice })
  }
  return (
    <>
      <Intro>Defaults for new tasks. Each task can change these from its input bar. Changes save automatically.</Intro>
      <SettingRow name="Model" description="Used for new tasks.">
        <ModelPicker models={models} value={settings.defaultModel} onChoose={chooseModel} />
      </SettingRow>
      {efforts.length > 0 && (
        <SettingRow name="Effort" description="How long the agent thinks before acting.">
          <Segmented
            label="Effort"
            options={efforts.map((effort): SegmentedOption<Effort> => ({ value: effort, label: EFFORT_NAMES[effort] }))}
            value={settings.defaultEffort}
            onChange={(defaultEffort) => {
              update({ defaultEffort })
            }}
          />
        </SettingRow>
      )}
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

interface PluginRowProps {
  plugin: InstalledPlugin
  onToggle: (id: string, enabled: boolean) => void
  /** Turns one of the plugin's capabilities on or off (`plugins.setCapability`). */
  onCapability: (id: string, capability: PluginCapability, granted: boolean) => void
  /** Sets one of the settings the plugin declares (`plugins.setSetting`). */
  onSetting: (id: string, key: string, value: string) => void
  /** Reloads the plugin's view now, if it's the one shown (`plugins.reload`); a no-op otherwise. */
  onReload: (id: string) => void
}

interface PluginSelectProps {
  /** The plugin's name, which the select's own name starts with. */
  plugin: string
  setting: PluginSelectSetting
  /** The option chosen: one of the setting's values. */
  value: string
  onChoose: (value: string) => void
}

/**
 * One of a plugin's `select` settings: a button naming the option chosen, which opens a menu of the options with it
 * checked, as the model picker does.
 */
function PluginSelect({ plugin, setting, value, onChoose }: PluginSelectProps): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const chosen = setting.options.find((option) => option.value === value)?.label ?? value
  const entries: MenuEntry[] = setting.options.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.label,
    checked: option.value === value,
    onSelect: () => {
      onChoose(option.value)
    },
  }))
  return (
    <>
      <button
        type="button"
        aria-label={`${plugin}: ${setting.label}: ${chosen}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        className={classNames(styles.select, styles.pluginSelect)}
        onClick={(event) => {
          setAnchor(event.currentTarget)
        }}
      >
        {chosen}
        <Icon icon={faChevronDown} size={IconSize.Small} />
      </button>
      <Menu
        label={setting.label}
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

interface PluginSettingRowProps {
  plugin: ValidPlugin
  setting: PluginSetting
  onSetting: (id: string, key: string, value: string) => void
}

/**
 * One of the settings a plugin declares, under its row: its label, and the control for its type. There's one type so
 * far, a select; a second one fails the typecheck here (`PluginSelect` takes only a select) until it has its control.
 */
function PluginSettingRow({ plugin, setting, onSetting }: PluginSettingRowProps): React.JSX.Element {
  return (
    <div className={styles.pluginCapability}>
      <span className={styles.pluginCapabilityText}>{setting.label}</span>
      <PluginSelect
        plugin={plugin.manifest.name}
        setting={setting}
        value={plugin.settings[setting.key] ?? setting.default}
        onChoose={(value) => {
          onSetting(plugin.folder, setting.key, value)
        }}
      />
    </div>
  )
}

/**
 * One plugin: its icon, name and version, Reload and its toggle, and under them a switch for each capability it asks
 * for, off until you turn it on, and a select for each setting it declares; or, for an invalid one, its folder and why.
 */
function PluginRow({ plugin, onToggle, onCapability, onSetting, onReload }: PluginRowProps): React.JSX.Element {
  switch (plugin.status) {
    case PluginStatus.Valid: {
      const { manifest } = plugin
      return (
        <div role="listitem" aria-label={manifest.name} className={styles.pluginItem}>
          <PluginSummary plugin={plugin} onToggle={onToggle} onReload={onReload} />
          {manifest.capabilities.map((capability) => (
            <div key={capability} className={styles.pluginCapability}>
              <span className={styles.pluginCapabilityText}>{PLUGIN_CAPABILITY_LABELS[capability]}</span>
              <Toggle
                label={`${manifest.name}: ${PLUGIN_CAPABILITY_LABELS[capability]}`}
                checked={isGranted(plugin, capability)}
                onChange={(granted) => {
                  onCapability(plugin.folder, capability, granted)
                }}
              />
            </div>
          ))}
          {manifest.settings.map((setting) => (
            <PluginSettingRow key={setting.key} plugin={plugin} setting={setting} onSetting={onSetting} />
          ))}
        </div>
      )
    }
    case PluginStatus.Invalid:
      return (
        <div role="listitem" aria-label={plugin.folder} className={classNames(styles.row, styles.pluginRow)}>
          <span className={classNames(styles.pluginTile, styles.invalidTile)} aria-hidden="true">
            <Icon icon={faTriangleExclamation} size={IconSize.Medium} />
          </span>
          <div className={styles.rowText}>
            <span className={styles.rowName}>{plugin.folder}</span>
            <span className={styles.pluginReason}>{plugin.reason}</span>
          </div>
        </div>
      )
  }
}

interface PluginSummaryProps {
  plugin: ValidPlugin
  onToggle: (id: string, enabled: boolean) => void
  onReload: (id: string) => void
}

/** A valid plugin's own row: its icon, name and version, Reload and its toggle. */
function PluginSummary({ plugin, onToggle, onReload }: PluginSummaryProps): React.JSX.Element {
  const { manifest } = plugin
  return (
    <div className={styles.pluginRow}>
      <span className={styles.pluginTile} aria-hidden="true">
        {plugin.iconUrl === null ? (
          <Icon icon={faPuzzlePiece} size={IconSize.Medium} />
        ) : (
          <img className={styles.pluginIcon} src={plugin.iconUrl} alt="" />
        )}
      </span>
      <div className={styles.rowText}>
        <span className={styles.rowName}>{manifest.name}</span>
        <span className={styles.pluginVersion}>{manifest.version}</span>
      </div>
      <Button
        variant={ButtonVariant.Icon}
        icon={faArrowsRotate}
        aria-label={`Reload ${manifest.name}`}
        title={`Reload ${manifest.name}`}
        onClick={() => {
          onReload(plugin.folder)
        }}
      />
      <Toggle
        label={manifest.name}
        checked={plugin.enabled}
        onChange={(enabled) => {
          onToggle(plugin.folder, enabled)
        }}
      />
    </div>
  )
}

/**
 * The plugins in the plugins folder (`docs/design/screens/21-settings-plugins.png`), which is read again each time
 * this opens: a row per plugin with its toggle (and under it a switch for each capability it asks for and a select for
 * each setting it declares), an invalid one with why, and Open plugins folder.
 */
export function PluginsSection(): React.JSX.Element {
  const plugins = useGladeStore((state) => state.plugins)
  const loadPlugins = useGladeStore((state) => state.loadPlugins)
  const setPluginEnabled = useGladeStore((state) => state.setPluginEnabled)
  const openPluginsFolder = useGladeStore((state) => state.openPluginsFolder)
  const reloadPlugin = useGladeStore((state) => state.reloadPlugin)
  const setPluginCapability = useGladeStore((state) => state.setPluginCapability)
  const setPluginSetting = useGladeStore((state) => state.setPluginSetting)
  // Whether the folder has been read since this opened: until then, the list may be out of date.
  const [read, setRead] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(describeFailure(failure))
    }
  }

  useEffect(() => {
    // Aborted when the section closes before the folder has been read.
    const closed = new AbortController()
    void (async () => {
      try {
        await loadPlugins()
      } catch (failure) {
        if (!closed.signal.aborted) setError(describeFailure(failure))
      }
      if (!closed.signal.aborted) setRead(true)
    })()
    return () => {
      closed.abort()
    }
  }, [loadPlugins])

  return (
    <>
      <Intro>
        Plugins show beside the terminal. Glade looks for new ones each time this opens. Changes save automatically.
      </Intro>
      <SettingRow
        name="Plugins folder"
        description="Copy a plugin's folder here to install it; delete it to remove it."
      >
        <Button size={ButtonSize.Small} onClick={() => void attempt(openPluginsFolder)}>
          Open plugins folder
        </Button>
      </SettingRow>
      <div role="list" aria-label="Plugins" aria-busy={!read} className={styles.pluginList}>
        {plugins?.map((plugin) => (
          <PluginRow
            key={plugin.folder}
            plugin={plugin}
            onToggle={(id, enabled) => void attempt(() => setPluginEnabled(id, enabled))}
            onCapability={(id, capability, granted) => void attempt(() => setPluginCapability(id, capability, granted))}
            onSetting={(id, key, value) => void attempt(() => setPluginSetting(id, key, value))}
            onReload={(id) => void attempt(() => reloadPlugin(id))}
          />
        ))}
      </div>
      {read && plugins?.length === 0 && <p className={styles.empty}>No plugins installed.</p>}
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  )
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

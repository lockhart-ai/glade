import type { Database } from 'better-sqlite3'
import { COMMAND_CHANNEL, EVENT_CHANNEL } from '../../shared/bridge'
import type { MenuState } from '../../shared/commands'
import type { Task } from '../../shared/domain'
import type { AgentBackend } from '../agent/backend'
import { createGladeMcpServer, GLADE_SERVER } from '../agent/glade-tools'
import { createControl, type Control } from '../control/control'
import { controlEnv, createControlEndpoint, type ControlEndpoint } from '../control/endpoint'
import { CONTROL_SERVER } from '../control/names'
import { createRateLimiter, type RateLimits } from '../control/rate-limit'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { createAccountTracker, type AccountTracker } from '../account/account'
import type { OpenPath, RevealPath, WriteClipboard } from '../files/files'
import type { NotifyReply } from '../notifications/notifications'
import { getSettings } from '../db/repositories/settings'
import { listTasks } from '../db/repositories/tasks'
import { listWorkspaces } from '../db/repositories/workspaces'
import { createEventLog } from '../logging/event-log'
import { SILENT_LOGGER, LogScope, type Logger } from '../logging/logger'
import { createPermissionBroker } from '../permissions/permissions'
import { createPluginFeed } from '../plugins/feed'
import { databaseFeedSource } from '../plugins/feed-source'
import { createPlugins, type Plugins } from '../plugins/plugins'
import { createPluginViews, type CreatePluginView, type PluginViews } from '../plugins/views'
import { createQuestionBroker } from '../questions/questions'
import { createBroadcast, createDispatcher, type EventTarget } from './dispatcher'
import type { Emit } from './events'
import { createHandlers } from './handlers'
import { REQUEST_SCHEMAS } from './requests'
import type { SpawnPty } from '../terminal/pty'
import type { TerminalShell } from '../terminal/shell'
import { createTerminals, type Terminals } from '../terminal/terminals'
import { refreshStaleTodos } from '../todos/todos'

/** The part of Electron's `ipcMain` the bridge uses, so tests can stand in a fake. */
export interface MainIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface BridgeOptions {
  readonly ipc: MainIpc
  readonly db: Database
  /** The windows' `webContents` open now, which events are sent to. */
  readonly targets: () => readonly EventTarget[]
  /** Shows the native open-folder dialog; resolves with the chosen path, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>
  /** Opens a file in the app macOS opens its kind of file with (Electron's `shell.openPath`): Open in editor. */
  readonly openPath: OpenPath
  /** Shows a file in Finder, selected (Electron's `shell.showItemInFolder`): an artifact's Reveal in folder. */
  readonly revealPath: RevealPath
  /** Puts text on the clipboard (Electron's `clipboard.writeText`): an artifact's Copy. */
  readonly writeClipboard: WriteClipboard
  /** What runs the tasks' agents: the Claude Agent SDK in the app, a scripted stand-in in tests. */
  readonly agentBackend: AgentBackend
  /** Notifies an agent reply in a task you aren't viewing (`../notifications`). Nothing by default. */
  readonly notifyReply?: NotifyReply
  /** Whether the network is up, for resuming a task paused offline (the runner's `isOnline`). Always up by default. */
  readonly isOnline?: () => boolean
  /** Rebuilds the menu bar from what the window says it shows (`menu.update`). Nothing by default. */
  readonly updateMenu?: (state: MenuState) => void
  /** Closes the focused window (`window.close`). Nothing by default. */
  readonly closeWindow?: () => void
  /** What the terminal tabs run their shells with. */
  readonly terminal: TerminalOptions
  /** The plugins folder, `<userData>/plugins`: a test mode's is in its throwaway data folder. */
  readonly pluginsFolder: string
  /** Makes the shown plugin's view (`../plugins/electron-view`). None by default: placing it does nothing. */
  readonly createPluginView?: CreatePluginView
  /** Glade's version, which plugins are told in `hello`. */
  readonly appVersion?: string
  /**
   * Whether a command came from Glade's own window, given the IPC event: a plugin's page, or anything else, can't send
   * one. Every sender is by default.
   */
  readonly isTrustedSender?: (event: unknown) => boolean
  /**
   * Claude Code's projects folder, whose sessions the control API lists and imports: `$CLAUDE_CONFIG_DIR/projects`, or
   * `~/.claude/projects`, by default.
   */
  readonly claudeProjectsDir?: string
  /**
   * Where the bridge logs its commands and events, and the runner and terminals what they do (`docs/logs.md`).
   * Nothing by default.
   */
  /** The control API's rate limits, per caller: 3,000 reads and 1,200 changes a minute by default. */
  readonly controlLimits?: RateLimits
  readonly log?: Logger
}

/** How the terminal tabs run their shells. */
export interface TerminalOptions {
  /** Starts a shell in a pseudo-terminal: node-pty in the app, a fake in unit tests. */
  readonly spawn: SpawnPty
  readonly shell: TerminalShell
  /** Where a shell starts with no workspace, or when its folder is gone. */
  readonly fallbackCwd: string
}

/** What the bridge started, for the app to shut down. */
export interface RegisteredBridge {
  readonly runner: AgentRunner
  /** Broadcasts an event to the windows. */
  readonly emit: Emit
  /** The terminal tabs, whose shells end when the app quits. */
  readonly terminals: Terminals
  /** The plugins in the plugins folder. */
  readonly plugins: Plugins
  /** The shown plugin's view, which ends when the app quits. */
  readonly pluginViews: PluginViews
  /** The control API (`glade-control`), which other agents drive Glade with. */
  readonly control: Control
  /**
   * The control API's HTTP endpoint: synced with the settings once the app has started (`sync`), and after each change
   * of the switch or the port; closed when the app quits.
   */
  readonly endpoint: ControlEndpoint
  /** The account the tasks run on and its usage warning, whose timer ends when the app quits. */
  readonly account: AccountTracker
}

/** Every task, in every workspace: what the event log and the plugin feed know of them to begin with. */
function allTasks(db: Database): Task[] {
  return listWorkspaces(db).flatMap((workspace) => listTasks(db, workspace.id))
}

/**
 * Answers the renderer's commands on the command channel and broadcasts events on the event channel, with an agent
 * runner on `agentBackend` for the tasks' agents.
 */
export function registerBridge({
  ipc,
  db,
  targets,
  chooseFolder,
  openPath,
  revealPath,
  writeClipboard,
  agentBackend,
  notifyReply,
  isOnline,
  terminal,
  pluginsFolder,
  createPluginView,
  appVersion = '0.0.0',
  isTrustedSender = () => true,
  updateMenu,
  closeWindow,
  controlLimits,
  log = SILENT_LOGGER,
  claudeProjectsDir,
}: BridgeOptions): RegisteredBridge {
  const broadcast = createBroadcast(EVENT_CHANNEL, targets)
  // Tasks that kept a todo list before Glade kept its summary get theirs before any window lists them.
  const refreshed = refreshStaleTodos(db)
  if (refreshed > 0) log.info('worked out todo summaries', { tasks: refreshed })
  const tasks = allTasks(db)
  // Every event is logged on its way to the windows: it's how a task's changes reach the log. The plugin feed sees each
  // too, and passes on what a plugin may know of it.
  const logEvent = createEventLog(log, tasks)
  const feed = createPluginFeed({ source: databaseFeedSource(db), tasks, log: log.scoped(LogScope.Plugins) })
  const emit: Emit = (event) => {
    logEvent(event)
    feed.observe(event)
    broadcast(event)
  }
  // One broker for the agent's questions: the Glade tools' `ask` waits on it, and the runner answers through it.
  const questions = createQuestionBroker({ db, emit }, notifyReply)
  // The permission requests the ask mode's tool calls wait on, notified as questions are.
  const permissions = createPermissionBroker({ db, emit }, notifyReply)
  // What the sessions say of the account and its usage limits, for Settings › General and the usage note.
  const account = createAccountTracker({ db, emit, log: log.scoped(LogScope.Runner) })
  const runner = createAgentRunner({
    db,
    emit,
    backend: agentBackend,
    notifyReply,
    questions,
    permissions,
    isOnline,
    account,
    log: log.scoped(LogScope.Runner),
    // Each session gets its own Glade tools, built for its task, with the upkeep Settings has on as it starts, and,
    // while agents may control Glade, the control tools, calling as its task.
    mcpServers: (task) => {
      const settings = getSettings(db)
      return {
        [GLADE_SERVER]: createGladeMcpServer({ db, emit, questions }, task.id, settings),
        ...(settings.controlEnabled ? { [CONTROL_SERVER]: control.sdkServer(task.id) } : {}),
      }
    },
    // While the endpoint listens, the agent's scripts can call it too: its URL and token are in their environment.
    sessionEnv: () => controlEnv(endpoint.status()),
  })
  // The control API, over the same runner and events as the window's commands, and its HTTP endpoint, which counts
  // against the same rate limits as one caller.
  const controlLog = log.scoped(LogScope.Control)
  const limiter = createRateLimiter(controlLimits === undefined ? {} : { limits: controlLimits })
  const control = createControl({
    db,
    emit,
    runner,
    limiter,
    log: controlLog,
    ...(claudeProjectsDir === undefined ? {} : { claudeProjectsDir }),
  })
  const endpoint = createControlEndpoint({ db, emit, limiter, control, log: controlLog })
  const terminals = createTerminals({ db, emit, ...terminal, log: log.scoped(LogScope.Terminal) })
  const pluginViews = createPluginViews({
    emit,
    feed,
    folder: pluginsFolder,
    appVersion,
    createView: createPluginView,
    log: log.scoped(LogScope.Plugins),
  })
  const plugins = createPlugins({
    db,
    emit,
    folder: pluginsFolder,
    openPath,
    onUpdate: (list) => {
      pluginViews.update(list)
    },
    log: log.scoped(LogScope.Plugins),
  })
  const dispatch = createDispatcher(
    createHandlers({
      db,
      emit,
      chooseFolder,
      openPath,
      revealPath,
      writeClipboard,
      runner,
      updateMenu,
      closeWindow,
      terminals,
      plugins,
      pluginViews,
      endpoint,
      account,
      log,
    }),
    REQUEST_SCHEMAS,
    log.scoped(LogScope.Ipc),
  )
  ipc.handle(COMMAND_CHANNEL, (event, command, request) => {
    if (!isTrustedSender(event)) {
      log.scoped(LogScope.Ipc).warn('command refused: not from the window', { command: String(command) })
      throw new Error("Commands come from Glade's window only")
    }
    return dispatch(command, request)
  })
  return { runner, emit, terminals, plugins, pluginViews, control, endpoint, account }
}

/**
 * What each context menu holds (`docs/context-menus.md`): its items in order, separators between the groups, and the
 * destructive items last, in pink. Each builder takes what its target is like and the actions to run, so the menus can
 * be checked against the reference without rendering anything.
 */
import { TaskState, type Task } from '../../shared/domain'
import { MenuEntryKind, MenuItemVariant, type MenuEntry, type MenuItem } from '../components'
import { SHORTCUT_HINTS, ShortcutAction } from './shortcutHints'

/** Runs a menu item. */
export type MenuAction = () => void

function item(label: string, onSelect: MenuAction, shortcut?: ShortcutAction): MenuItem {
  return {
    kind: MenuEntryKind.Item,
    label,
    onSelect,
    ...(shortcut === undefined ? {} : { shortcut: SHORTCUT_HINTS[shortcut] }),
  }
}

function destructive(label: string, onSelect: MenuAction, shortcut?: ShortcutAction): MenuItem {
  return { ...item(label, onSelect, shortcut), variant: MenuItemVariant.Destructive }
}

const SEPARATOR: MenuEntry = { kind: MenuEntryKind.Separator }

/** The groups, with a separator between each two, leaving out the empty ones. */
function groups(...parts: readonly (readonly MenuItem[])[]): MenuEntry[] {
  return parts
    .filter((part) => part.length > 0)
    .flatMap((part, index): MenuEntry[] => (index === 0 ? [...part] : [SEPARATOR, ...part]))
}

/** The item, or none when it doesn't apply. */
function when(applies: boolean, entry: () => MenuItem): MenuItem[] {
  return applies ? [entry()] : []
}

/** What a task's menu can do. */
export interface TaskMenuActions {
  readonly open: MenuAction
  readonly togglePin: MenuAction
  readonly rename: MenuAction
  readonly markUnread: MenuAction
  readonly markDone: MenuAction
  readonly reopen: MenuAction
  readonly copyLink: MenuAction
  readonly copyOutcome: MenuAction
  readonly delete: MenuAction
}

/** The label of the item that pins a task, or unpins a pinned one. */
export function pinLabel(pinned: boolean): string {
  return pinned ? 'Unpin' : 'Pin to top'
}

/**
 * A task's menu, on its row in the task list: an active task's can mark it unread or done, a done task's can reopen it
 * and copy its outcome.
 */
export function taskMenu(task: Pick<Task, 'state' | 'pinned'>, actions: TaskMenuActions): MenuEntry[] {
  const open = [item('Open', actions.open, ShortcutAction.Open)]
  const remove = [destructive('Delete task…', actions.delete)]
  switch (task.state) {
    case TaskState.Active:
      return groups(
        open,
        [
          item(pinLabel(task.pinned), actions.togglePin, ShortcutAction.TogglePin),
          item('Rename…', actions.rename, ShortcutAction.Rename),
          item('Mark as unread', actions.markUnread, ShortcutAction.MarkUnread),
        ],
        [item('Mark done', actions.markDone, ShortcutAction.MarkDone)],
        [item('Copy link to task', actions.copyLink)],
        remove,
      )
    case TaskState.Done:
      return groups(
        open,
        [item(pinLabel(task.pinned), actions.togglePin), item('Rename…', actions.rename)],
        [item('Reopen', actions.reopen)],
        [item('Copy link to task', actions.copyLink), item('Copy outcome', actions.copyOutcome)],
        remove,
      )
  }
}

/** What an agent reply's menu can do. */
export interface AgentReplyMenuActions {
  readonly copy: MenuAction
  readonly copyMarkdown: MenuAction
  readonly quote: MenuAction
  readonly showToolCalls: MenuAction
}

/** What an agent reply's menu needs to know about it. */
export interface AgentReplyMenuTarget {
  /** How many tool calls its turn made. */
  readonly toolCalls: number
}

/** An agent reply's menu. Show this turn's tool calls is only there when the turn made some, as the reply's chip is. */
export function agentReplyMenu(reply: AgentReplyMenuTarget, actions: AgentReplyMenuActions): MenuEntry[] {
  return groups(
    [
      item('Copy', actions.copy, ShortcutAction.Copy),
      item('Copy as Markdown', actions.copyMarkdown),
      item('Quote in reply', actions.quote),
    ],
    when(reply.toolCalls > 0, () => item("Show this turn's tool calls", actions.showToolCalls)),
  )
}

/** What a queued message's menu can do. */
export interface QueuedMessageMenuActions {
  readonly edit: MenuAction
  readonly remove: MenuAction
}

/** A queued message's menu: its two buttons, Edit and Remove. */
export function queuedMessageMenu(actions: QueuedMessageMenuActions): MenuEntry[] {
  return groups([item('Edit', actions.edit)], [destructive('Remove', actions.remove)])
}

/** What a tool call has for its menu to act on; null for what it hasn't. */
export interface ToolCallMenuTarget {
  /** The shell command it ran (Bash's `command`). */
  readonly command: string | null
  /** Its output, once it has some. */
  readonly output: string | null
  /** The file it worked on, relative to the workspace root, when it's inside it. */
  readonly file: string | null
}

/** What a tool call's menu can do. */
export interface ToolCallMenuActions {
  readonly copyCommand: MenuAction
  readonly copyOutput: MenuAction
  readonly openFile: MenuAction
  /** Puts the call's command at the terminal's prompt, without running it. */
  readonly runInTerminal: MenuAction
}

/** A tool call's menu, with each item only when the call has what it acts on. */
export function toolCallMenu(call: ToolCallMenuTarget, actions: ToolCallMenuActions): MenuEntry[] {
  return groups(
    [
      ...when(call.command !== null, () => item('Copy command', actions.copyCommand)),
      ...when(call.output !== null && call.output !== '', () => item('Copy output', actions.copyOutput)),
      ...when(call.file !== null, () => item('Open file', actions.openFile)),
    ],
    when(call.command !== null, () => item('Run again in terminal', actions.runInTerminal)),
  )
}

/** What a file tab's menu can do. */
export interface FileTabMenuActions {
  readonly close: MenuAction
  readonly closeOthers: MenuAction
  readonly closeAll: MenuAction
  readonly openInEditor: MenuAction
  readonly reveal: MenuAction
  readonly copyPath: MenuAction
  readonly copyRelativePath: MenuAction
}

/** A file tab's menu, in the Files tab. */
export function fileTabMenu(actions: FileTabMenuActions): MenuEntry[] {
  return groups(
    [
      item('Close', actions.close, ShortcutAction.CloseFileTab),
      item('Close others', actions.closeOthers),
      item('Close all', actions.closeAll),
    ],
    [
      item('Open in editor', actions.openInEditor, ShortcutAction.OpenInEditor),
      item('Reveal in Finder', actions.reveal),
      item('Copy path', actions.copyPath),
      item('Copy relative path', actions.copyRelativePath),
    ],
  )
}

/** What an artifact's menu can do. */
export interface ArtifactMenuActions {
  readonly open: MenuAction
  readonly openInEditor: MenuAction
  readonly copyContents: MenuAction
  readonly copyPath: MenuAction
  readonly reveal: MenuAction
  readonly remove: MenuAction
}

/** An artifact's menu, in the Artifacts tab: its card's buttons, and more. Removing it leaves the file alone. */
export function artifactMenu(actions: ArtifactMenuActions): MenuEntry[] {
  return groups(
    [
      item('Open', actions.open, ShortcutAction.Open),
      item('Open in editor', actions.openInEditor, ShortcutAction.OpenInEditor),
    ],
    [
      item('Copy contents', actions.copyContents),
      item('Copy path', actions.copyPath),
      item('Reveal in Finder', actions.reveal),
    ],
    [destructive('Remove from artifacts', actions.remove)],
  )
}

/** What a subagent's menu can do. */
export interface SubagentMenuActions {
  readonly toggleLog: MenuAction
  readonly copyLog: MenuAction
  /** Stops the subagent; null when it can't be stopped, because it isn't running. */
  readonly stop: MenuAction | null
}

/** What a subagent's menu needs to know about it. */
export interface SubagentMenuTarget {
  /** Whether its log is open. */
  readonly expanded: boolean
}

/** A subagent's menu, in the Subagents tab: its log opens (or closes, once open), copies, and it stops while it runs. */
export function subagentMenu(subagent: SubagentMenuTarget, actions: SubagentMenuActions): MenuEntry[] {
  const { stop } = actions
  return groups(
    [
      item(subagent.expanded ? 'Collapse log' : 'Expand log', actions.toggleLog, ShortcutAction.Open),
      item('Copy log', actions.copyLog),
    ],
    stop === null ? [] : [destructive('Stop subagent', stop)],
  )
}

/** What a terminal tab's menu can do. */
export interface TerminalTabMenuActions {
  readonly rename: MenuAction
  readonly duplicate: MenuAction
  readonly clear: MenuAction
  readonly kill: MenuAction
  readonly close: MenuAction
}

/**
 * A terminal tab's menu, in the bottom bar. Kill process is pink, as the design (`13-context-menus.html`) has it, and
 * Close follows it there, the one menu whose destructive item isn't last.
 */
export function terminalTabMenu(actions: TerminalTabMenuActions): MenuEntry[] {
  return groups(
    [
      item('Rename…', actions.rename),
      item('Duplicate', actions.duplicate),
      item('Clear', actions.clear, ShortcutAction.ClearTerminal),
    ],
    [
      destructive('Kill process', actions.kill, ShortcutAction.KillProcess),
      item('Close', actions.close, ShortcutAction.CloseTerminalTab),
    ],
  )
}

/** What a todo's menu can do. */
export interface TodoMenuActions {
  readonly copy: MenuAction
  readonly ask: MenuAction
}

/**
 * A todo's menu, in the Todos tab. The agent keeps the list with Claude Code's own todo tools, so there's no Mark done
 * myself or Remove: the agent's next change to the list would overwrite either.
 */
export function todoMenu(actions: TodoMenuActions): MenuEntry[] {
  return groups([item('Copy', actions.copy), item('Ask agent about this', actions.ask)])
}

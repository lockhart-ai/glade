/**
 * What each context menu holds (`docs/context-menus.md`): its items in order, separators between the groups, and the
 * destructive items last, in pink. Each builder takes what its target is like and the actions to run, so the menus can
 * be checked against the reference without rendering anything.
 */
import { pinLabel } from '../../shared/commands'
import { TaskState, type Task } from '../../shared/domain'
import { MenuEntryKind, MenuItemVariant, type MenuEntry, type MenuItem } from '../components'
import { SHORTCUT_HINTS, ShortcutAction, type ShortcutHints } from './shortcutHints'

/** Runs a menu item. */
export type MenuAction = () => void

/** An item, with the keys of its shortcut as `hints` show them (the defaults, unless the builder is given others). */
function item(label: string, onSelect: MenuAction, shortcut?: ShortcutAction, hints = SHORTCUT_HINTS): MenuItem {
  return {
    kind: MenuEntryKind.Item,
    label,
    onSelect,
    ...(shortcut === undefined ? {} : { shortcut: hints[shortcut] }),
  }
}

function destructive(label: string, onSelect: MenuAction): MenuItem {
  return { kind: MenuEntryKind.Item, label, onSelect, variant: MenuItemVariant.Destructive }
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

export { pinLabel }

/**
 * A task's menu, on its row in the task list: an active task's can mark it unread or done, a done task's can reopen it
 * and copy its outcome. `hints` are the shortcuts' current keys.
 */
export function taskMenu(
  task: Pick<Task, 'state' | 'pinned'>,
  actions: TaskMenuActions,
  hints: ShortcutHints,
): MenuEntry[] {
  const open = [item('Open', actions.open, ShortcutAction.Open, hints)]
  const remove = [destructive('Delete task…', actions.delete)]
  switch (task.state) {
    case TaskState.Active:
      return groups(
        open,
        [
          item(pinLabel(task.pinned), actions.togglePin, ShortcutAction.TogglePin, hints),
          item('Rename…', actions.rename, ShortcutAction.Rename, hints),
          item('Mark as unread', actions.markUnread, ShortcutAction.MarkUnread, hints),
        ],
        [item('Mark done', actions.markDone, ShortcutAction.MarkDone, hints)],
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
}

/**
 * A tool call's menu, with each item only when the call has what it acts on. Run again in terminal waits for the
 * terminal (P8).
 */
export function toolCallMenu(call: ToolCallMenuTarget, actions: ToolCallMenuActions): MenuEntry[] {
  return groups([
    ...when(call.command !== null, () => item('Copy command', actions.copyCommand)),
    ...when(call.output !== null && call.output !== '', () => item('Copy output', actions.copyOutput)),
    ...when(call.file !== null, () => item('Open file', actions.openFile)),
  ])
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

/** A file tab's menu, in the Files tab. `hints` are the shortcuts' current keys. */
export function fileTabMenu(actions: FileTabMenuActions, hints: ShortcutHints): MenuEntry[] {
  return groups(
    [
      item('Close', actions.close, ShortcutAction.CloseFileTab, hints),
      item('Close others', actions.closeOthers),
      item('Close all', actions.closeAll),
    ],
    [
      item('Open in editor', actions.openInEditor, ShortcutAction.OpenInEditor, hints),
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

/**
 * An artifact's menu, in the Artifacts tab: its card's buttons, and more. Removing it leaves the file alone. `hints` are
 * the shortcuts' current keys.
 */
export function artifactMenu(actions: ArtifactMenuActions, hints: ShortcutHints): MenuEntry[] {
  return groups(
    [
      item('Open', actions.open, ShortcutAction.Open, hints),
      item('Open in editor', actions.openInEditor, ShortcutAction.OpenInEditor, hints),
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

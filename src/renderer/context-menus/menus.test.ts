import { describe, expect, it, vi } from 'vitest'
import REFERENCE from '../../../docs/context-menus.md?raw'
import { TaskState } from '../../shared/domain'
import { MenuEntryKind, MenuItemVariant, type MenuEntry, type MenuItem } from '../components'
import {
  agentReplyMenu,
  artifactMenu,
  fileTabMenu,
  pinLabel,
  queuedMessageMenu,
  subagentMenu,
  taskMenu,
  todoMenu,
  toolCallMenu,
  type MenuAction,
} from './menus'
import { TaskCommandId, WindowCommandId } from '../../shared/commands'
import { resolveKeymap } from '../../shared/keymap'
import { SHORTCUT_HINTS, ShortcutAction, shortcutHints } from './shortcutHints'

/** The items the reference (`docs/context-menus.md`) lists for a target, as `label shortcut` strings, with `—` for each separator. */
function referenceItems(target: string): string[] {
  const row = REFERENCE.split('\n').find((line) => line.startsWith(`| ${target} |`))
  if (row === undefined) throw new Error(`No row for ${target} in docs/context-menus.md`)
  const cell = row.split('|')[2]?.trim() ?? ''
  return cell.split(' · ')
}

/** A menu's entries written as the reference writes them. */
function written(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case MenuEntryKind.Separator:
        return '—'
      case MenuEntryKind.Heading:
        return `# ${entry.label}`
      case MenuEntryKind.Item:
        return entry.shortcut === undefined ? entry.label : `${entry.label} ${entry.shortcut}`
    }
  })
}

/** The reference's items without some, and without the separators that leaves doubled or at an end. */
function without(items: readonly string[], left: readonly string[]): string[] {
  const kept = items.filter((item) => !left.includes(item))
  return kept.filter(
    (item, index) =>
      item !== '—' || (index > 0 && index < kept.length - 1 && kept[index + 1] !== '—' && kept[index - 1] !== '—'),
  )
}

function items(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.filter((entry): entry is MenuItem => entry.kind === MenuEntryKind.Item)
}

/** A set of actions, each a spy named after its key. */
function spies<K extends string>(...names: readonly K[]): Record<K, MenuAction> {
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as unknown as Record<K, MenuAction>
}

const TASK_ACTIONS = spies(
  'open',
  'togglePin',
  'rename',
  'markUnread',
  'markDone',
  'reopen',
  'copyLink',
  'copyOutcome',
  'delete',
)

interface Case {
  /** The reference's name for the target. */
  readonly target: string
  /** The menu built for the target at its fullest. */
  readonly entries: readonly MenuEntry[]
  /** The reference's items the menu leaves out, and why (in the report). */
  readonly leftOut: readonly string[]
}

const CASES: readonly Case[] = [
  {
    target: 'Task (active), sidebar row',
    entries: taskMenu({ state: TaskState.Active, pinned: false }, TASK_ACTIONS, SHORTCUT_HINTS),
    leftOut: [],
  },
  {
    target: 'Task (done), row or search result',
    entries: taskMenu({ state: TaskState.Done, pinned: false }, TASK_ACTIONS, SHORTCUT_HINTS),
    leftOut: [],
  },
  {
    target: 'Chat message (agent reply)',
    entries: agentReplyMenu({ toolCalls: 3 }, spies('copy', 'copyMarkdown', 'quote', 'showToolCalls')),
    leftOut: [],
  },
  { target: 'Queued message', entries: queuedMessageMenu(spies('edit', 'remove')), leftOut: [] },
  {
    target: 'Tool call',
    entries: toolCallMenu(
      { command: 'npm test', output: '148 passed', file: 'src/date.ts' },
      spies('copyCommand', 'copyOutput', 'openFile'),
    ),
    // The terminal is P8.
    leftOut: ['Run again in terminal'],
  },
  {
    target: 'File tab / file',
    entries: fileTabMenu(
      spies('close', 'closeOthers', 'closeAll', 'openInEditor', 'reveal', 'copyPath', 'copyRelativePath'),
      SHORTCUT_HINTS,
    ),
    leftOut: [],
  },
  {
    target: 'Artifact',
    entries: artifactMenu(
      spies('open', 'openInEditor', 'copyContents', 'copyPath', 'reveal', 'remove'),
      SHORTCUT_HINTS,
    ),
    leftOut: [],
  },
  {
    target: 'Subagent',
    entries: subagentMenu({ expanded: false }, { ...spies('toggleLog', 'copyLog'), stop: vi.fn() }),
    leftOut: [],
  },
  {
    target: 'Todo',
    entries: todoMenu(spies('copy', 'ask')),
    // Claude Code keeps the list: an edit of Glade's own would be overwritten by the agent's next change to it.
    leftOut: ['Mark done myself', 'Remove'],
  },
]

describe('the context menus', () => {
  it.each(CASES)('$target: has the reference’s items, in order, with their keys', ({ target, entries, leftOut }) => {
    expect(written(entries)).toEqual(without(referenceItems(target), leftOut))
  })

  it.each(CASES)('$target: puts its destructive items last, in pink', ({ entries }) => {
    const destructive = items(entries).map((item) => item.variant === MenuItemVariant.Destructive)
    expect(destructive).toEqual([...destructive].sort((a, b) => Number(a) - Number(b)))
  })

  it('marks deleting a task, removing a queued message or an artifact, and stopping a subagent as destructive, and nothing else', () => {
    const labels = CASES.flatMap(({ entries }) =>
      items(entries)
        .filter((item) => item.variant === MenuItemVariant.Destructive)
        .map((item) => item.label),
    )
    expect(labels).toEqual(['Delete task…', 'Delete task…', 'Remove', 'Remove from artifacts', 'Stop subagent'])
  })

  it('shows the keys of the shortcut hints, which are the keymap’s defaults until you rebind them', () => {
    const shown = CASES.flatMap(({ entries }) => items(entries).flatMap((item) => item.shortcut ?? []))
    expect(new Set(shown)).toEqual(new Set(Object.values(SHORTCUT_HINTS)))
  })

  it('left out only the target that isn’t built: terminal tabs (P8)', () => {
    const targets = REFERENCE.split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Target') && !line.startsWith('|---'))
      .map((line) => line.split('|')[1]?.trim())
    expect(targets.filter((target) => !CASES.some((c) => c.target === target))).toEqual(['Terminal tab'])
  })
})

describe('shortcutHints', () => {
  it('shows each command’s current binding, and ⌘C for Copy', () => {
    const keymap = resolveKeymap({
      [TaskCommandId.TogglePin]: 'Meta+Alt+P',
      [WindowCommandId.OpenInEditor]: 'Ctrl+E',
    })
    const hints = shortcutHints(keymap)

    expect(hints).toEqual({
      ...SHORTCUT_HINTS,
      [ShortcutAction.TogglePin]: '⌘⌥P',
      [ShortcutAction.OpenInEditor]: '⌃E',
    })
    expect(SHORTCUT_HINTS[ShortcutAction.Copy]).toBe('⌘C')
    expect(written(taskMenu({ state: TaskState.Active, pinned: true }, TASK_ACTIONS, hints))).toContain('Unpin ⌘⌥P')
    expect(
      written(
        fileTabMenu(
          spies('close', 'closeOthers', 'closeAll', 'openInEditor', 'reveal', 'copyPath', 'copyRelativePath'),
          hints,
        ),
      ),
    ).toContain('Open in editor ⌃E')
  })
})

describe('taskMenu', () => {
  it('unpins a pinned task', () => {
    expect(pinLabel(true)).toBe('Unpin')
    expect(written(taskMenu({ state: TaskState.Active, pinned: true }, TASK_ACTIONS, SHORTCUT_HINTS))).toContain(
      'Unpin ⌘⇧P',
    )
    expect(written(taskMenu({ state: TaskState.Done, pinned: true }, TASK_ACTIONS, SHORTCUT_HINTS))).toContain('Unpin')
  })

  it('runs each item’s action', () => {
    const labels = (state: TaskState) => items(taskMenu({ state, pinned: false }, TASK_ACTIONS, SHORTCUT_HINTS))
    for (const item of [...labels(TaskState.Active), ...labels(TaskState.Done)]) item.onSelect()
    expect(TASK_ACTIONS.open).toHaveBeenCalledTimes(2)
    expect(TASK_ACTIONS.markDone).toHaveBeenCalledOnce()
    expect(TASK_ACTIONS.reopen).toHaveBeenCalledOnce()
    expect(TASK_ACTIONS.copyOutcome).toHaveBeenCalledOnce()
    expect(TASK_ACTIONS.delete).toHaveBeenCalledTimes(2)
  })
})

describe('agentReplyMenu', () => {
  it('leaves out showing the turn’s tool calls when it made none', () => {
    expect(written(agentReplyMenu({ toolCalls: 0 }, spies('copy', 'copyMarkdown', 'quote', 'showToolCalls')))).toEqual([
      'Copy ⌘C',
      'Copy as Markdown',
      'Quote in reply',
    ])
  })
})

describe('toolCallMenu', () => {
  it('has only the items the call has something for', () => {
    const actions = spies('copyCommand', 'copyOutput', 'openFile')
    expect(written(toolCallMenu({ command: null, output: 'src/date.ts', file: null }, actions))).toEqual([
      'Copy output',
    ])
    expect(written(toolCallMenu({ command: null, output: '', file: 'src/date.ts' }, actions))).toEqual(['Open file'])
    expect(toolCallMenu({ command: null, output: null, file: null }, actions)).toEqual([])
  })
})

describe('subagentMenu', () => {
  it('collapses an open log, and can’t stop a subagent that isn’t running', () => {
    expect(written(subagentMenu({ expanded: true }, { ...spies('toggleLog', 'copyLog'), stop: null }))).toEqual([
      'Collapse log ↵',
      'Copy log',
    ])
  })
})

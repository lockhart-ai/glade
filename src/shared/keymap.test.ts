import { describe, expect, it } from 'vitest'
import { AppCommandId, WorkspaceCommandId, TaskCommandId, WindowCommandId } from './commands'
import {
  bindingProblem,
  BindingProblemKind,
  chordFromEvent,
  COMMANDS,
  commandDefinition,
  DEFAULT_KEYMAP,
  describeBindingProblem,
  FixedReason,
  formatBinding,
  formatChord,
  isRebindable,
  KEYMAP_LAYOUT,
  matchCommand,
  parseChord,
  RESERVED_CHORDS,
  resolveKeymap,
  sameChord,
  serializeChord,
  toAccelerator,
  withBinding,
  withDefault,
  type KeyChord,
  type KeyPress,
  type ShortcutId,
} from './keymap'

/** Every command with a shortcut: the menu bar's that have one, and all the window's own. */
const SHORTCUT_IDS: readonly ShortcutId[] = [
  ...Object.values(AppCommandId),
  WorkspaceCommandId.Switch,
  WorkspaceCommandId.Close,
  TaskCommandId.TogglePin,
  TaskCommandId.Rename,
  TaskCommandId.MarkUnread,
  TaskCommandId.MarkDone,
  ...Object.values(WindowCommandId),
]

/** A chord from how it's stored, failing the test if it doesn't parse. */
function chord(text: string): KeyChord {
  const parsed = parseChord(text)
  if (parsed === null) throw new Error(`Doesn't parse: ${text}`)
  return parsed
}

function pressed(init: Partial<KeyPress>): KeyPress {
  return { key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }
}

describe('chords', () => {
  it.each([
    ['Meta+Shift+P', '⌘⇧P', 'CmdOrCtrl+Shift+P'],
    ['Meta+Alt+ArrowDown', '⌘⌥↓', 'CmdOrCtrl+Alt+Down'],
    ['Ctrl+Shift+Tab', '⌃⇧⇥', 'Ctrl+Shift+Tab'],
    ['Ctrl+`', '⌃`', 'Ctrl+`'],
    ['Shift+F10', '⇧F10', 'Shift+F10'],
    ['Enter', '↵', 'Enter'],
    ['Escape', 'Esc', 'Escape'],
    ['Alt+ArrowUp', '⌥↑', 'Alt+Up'],
    ['Meta+ArrowLeft', '⌘←', 'CmdOrCtrl+Left'],
    ['Meta+ArrowRight', '⌘→', 'CmdOrCtrl+Right'],
    ['Meta+Backspace', '⌘⌫', 'CmdOrCtrl+Backspace'],
    ['Meta+Delete', '⌘⌦', 'CmdOrCtrl+Delete'],
    ['Ctrl+Space', '⌃Space', 'Ctrl+Space'],
    ['Meta++', '⌘+', 'CmdOrCtrl+Plus'],
    ['Meta+,', '⌘,', 'CmdOrCtrl+,'],
  ])('%s shows as %s, is the menu bar’s %s, and stores as it was', (stored, shown, accelerator) => {
    const parsed = chord(stored)

    expect(formatChord(parsed)).toBe(shown)
    expect(toAccelerator(parsed)).toBe(accelerator)
    expect(serializeChord(parsed)).toBe(stored)
  })

  it('stores its modifiers in one order, however they were written', () => {
    expect(serializeChord(chord('Shift+Alt+Meta+Ctrl+K'))).toBe('Ctrl+Meta+Alt+Shift+K')
  })

  it.each(['', 'Meta+', 'Hyper+K', 'Meta+Meta+K', '+', 'meta+K'])('%o isn’t a chord', (text) => {
    expect(parseChord(text)).toBeNull()
  })

  it('compares keys and each modifier', () => {
    expect(sameChord(chord('Meta+K'), chord('Meta+K'))).toBe(true)
    expect(sameChord(chord('Meta+K'), chord('Meta+J'))).toBe(false)
    expect(sameChord(chord('Meta+K'), chord('Meta+Shift+K'))).toBe(false)
    expect(sameChord(chord('Ctrl+K'), chord('Meta+K'))).toBe(false)
    expect(sameChord(chord('Alt+K'), chord('K'))).toBe(false)
  })
})

describe('chordFromEvent', () => {
  it.each([
    ['a letter, in upper case', { key: 'n', code: 'KeyN', metaKey: true }, 'Meta+N'],
    ['a letter by the character typed, following the layout', { key: 'n', code: 'KeyB', metaKey: true }, 'Meta+N'],
    ['⌥ with a letter, by the physical key', { key: '∫', code: 'KeyB', metaKey: true, altKey: true }, 'Meta+Alt+B'],
    ['⌥ with a digit, by the physical key', { key: '™', code: 'Digit2', metaKey: true, altKey: true }, 'Meta+Alt+2'],
    [
      '⇧ with a digit, by the physical key',
      { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true },
      'Ctrl+Shift+1',
    ],
    ['⇧ with a letter', { key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }, 'Meta+Shift+P'],
    ['a key with no character, by the physical key', { key: '', code: 'KeyW', metaKey: true }, 'Meta+W'],
    ['a dead key, by the physical key', { key: 'Dead', code: 'KeyE', altKey: true }, 'Alt+E'],
    ['a named key', { key: 'ArrowDown', altKey: true }, 'Alt+ArrowDown'],
    ['an F-key', { key: 'F10', code: 'F10', shiftKey: true }, 'Shift+F10'],
    ['punctuation', { key: ',', code: 'Comma', metaKey: true }, 'Meta+,'],
    [
      '⇧ with punctuation, by the character typed',
      { key: '<', code: 'Comma', metaKey: true, shiftKey: true },
      'Meta+Shift+<',
    ],
    ['the space bar', { key: ' ', code: 'Space', ctrlKey: true }, 'Ctrl+Space'],
  ])('reads %s', (_, init, stored) => {
    const result = chordFromEvent(pressed(init))
    expect(result === null ? null : serializeChord(result)).toBe(stored)
  })

  it.each([
    ['⌘ alone', { key: 'Meta', code: 'MetaLeft', metaKey: true }],
    ['⇧ alone', { key: 'Shift', code: 'ShiftLeft', shiftKey: true }],
    ['a key it can’t read', { key: 'Unidentified', code: 'IntlRo' }],
    ['nothing', {}],
  ])('makes no chord of %s', (_, init) => {
    expect(chordFromEvent(pressed(init))).toBeNull()
  })
})

describe('the commands', () => {
  it('each have one definition, and the keymap’s layout shows each of them', () => {
    expect(COMMANDS.map(({ id }) => id).sort()).toEqual([...SHORTCUT_IDS].sort())
    const shown = KEYMAP_LAYOUT.flatMap(({ rows }) => rows.flatMap(({ keys }) => keys.map(({ command }) => command)))
    expect([...new Set(shown)].sort()).toEqual([...SHORTCUT_IDS].sort())
    for (const group of KEYMAP_LAYOUT) {
      for (const row of group.rows) {
        for (const { command } of row.keys) expect(commandDefinition(command).area).toBe(group.area)
      }
    }
  })

  it('each take one binding you can change, but for the few fixed ones', () => {
    const fixed = COMMANDS.filter(({ id }) => !isRebindable(id)).map(({ id, fixed: reason }) => [id, reason])
    expect(fixed).toEqual([
      [WindowCommandId.NewLine, FixedReason.TextField],
      [AppCommandId.Close, FixedReason.Window],
      [WindowCommandId.KillProcess, FixedReason.Shell],
      [WindowCommandId.MenuMove, FixedReason.Menus],
      [WindowCommandId.MenuChoose, FixedReason.Menus],
      [WindowCommandId.MenuClose, FixedReason.Menus],
      [WindowCommandId.SelectAnswer, FixedReason.Menus],
    ])
    for (const { id, defaults } of COMMANDS) if (isRebindable(id)) expect(defaults).toHaveLength(1)
  })

  it('can each be bound to their own default, which no other command has where they apply', () => {
    for (const { id, defaults } of COMMANDS) {
      if (!isRebindable(id)) continue
      const [binding] = defaults
      expect(binding).toBeDefined()
      if (binding !== undefined) expect(bindingProblem(id, binding, DEFAULT_KEYMAP)).toBeNull()
    }
  })
})

describe('resolveKeymap', () => {
  it('takes the bindings you’ve changed, and the defaults for the rest', () => {
    const keymap = resolveKeymap({ [AppCommandId.NewTask]: 'Meta+Shift+T' })

    expect(keymap[AppCommandId.NewTask]).toEqual([chord('Meta+Shift+T')])
    expect(keymap[TaskCommandId.MarkDone]).toEqual([chord('Meta+Shift+D')])
    expect(resolveKeymap({})).toEqual(DEFAULT_KEYMAP)
  })

  it('ignores a change that doesn’t parse, or is to a fixed command', () => {
    const keymap = resolveKeymap({ [AppCommandId.NewTask]: 'Meta+', [AppCommandId.Close]: 'Meta+Shift+W' })

    expect(keymap).toEqual(DEFAULT_KEYMAP)
  })
})

describe('matchCommand', () => {
  const match = (id: ShortcutId, stored: string) =>
    matchCommand(commandDefinition(id), DEFAULT_KEYMAP[id], chord(stored))

  it('matches a command’s own chord, exactly', () => {
    expect(match(TaskCommandId.MarkDone, 'Meta+Shift+D')).toEqual({ digit: null })
    expect(match(TaskCommandId.MarkDone, 'Meta+D')).toBeNull()
    expect(match(TaskCommandId.MarkDone, 'Meta+Alt+Shift+D')).toBeNull()
  })

  it('matches any digit of a range with its modifiers, and says which', () => {
    expect(match(WorkspaceCommandId.Switch, 'Meta+7')).toEqual({ digit: 7 })
    expect(match(WindowCommandId.ShowPanelTab, 'Meta+Alt+5')).toEqual({ digit: 5 })
    expect(match(WindowCommandId.ShowPanelTab, 'Meta+Alt+6')).toBeNull()
    expect(match(WorkspaceCommandId.Switch, 'Meta+0')).toBeNull()
    expect(match(WorkspaceCommandId.Switch, 'Meta+Shift+1')).toBeNull()
    expect(match(WorkspaceCommandId.Switch, 'Meta+K')).toBeNull()
  })

  it('matches either key of a command with two', () => {
    expect(match(WindowCommandId.MenuMove, 'ArrowUp')).toEqual({ digit: null })
    expect(match(WindowCommandId.MenuMove, 'ArrowDown')).toEqual({ digit: null })
  })
})

describe('bindingProblem', () => {
  const problem = (id: ShortcutId, stored: string) => bindingProblem(id, chord(stored), DEFAULT_KEYMAP)

  it.each(
    RESERVED_CHORDS.map(({ chord: reserved, owner }) => [formatChord(reserved), owner, serializeChord(reserved)]),
  )('refuses %s, which is %s’s', (_, owner, stored) => {
    expect(problem(AppCommandId.NewTask, stored)).toEqual({ kind: BindingProblemKind.Reserved, owner })
  })

  it('lets a range take its own digits, with other modifiers too', () => {
    expect(problem(WorkspaceCommandId.Switch, 'Meta+Shift+5')).toBeNull()
    expect(bindingProblem(WorkspaceCommandId.Switch, chord('Meta+1'), resolveKeymap({}))).toBeNull()
  })

  it('refuses keys another command has where both apply, a range’s digits included', () => {
    expect(problem(AppCommandId.NewTask, 'Meta+B')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: AppCommandId.ToggleSidebar,
    })
    expect(problem(AppCommandId.NewTask, 'Meta+4')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WorkspaceCommandId.Switch,
    })
    expect(problem(WorkspaceCommandId.Switch, 'Meta+Shift+1')).toBeNull()
    expect(problem(WorkspaceCommandId.Switch, 'Meta+Alt+9')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.ShowPanelTab,
    })
    // The window's shortcuts reach the terminal, and the focused row.
    expect(problem(AppCommandId.NewTask, 'Ctrl+C')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.KillProcess,
    })
    expect(problem(WindowCommandId.ContextMenu, 'Meta+J')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: AppCommandId.ToggleBottomBar,
    })
    // The message field's own keys.
    expect(problem(WindowCommandId.Send, 'Shift+Enter')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.NewLine,
    })
    expect(problem(WindowCommandId.NextTask, 'Alt+ArrowUp')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.PreviousTask,
    })
    // ⌥↑ / ⌥↓ reach the message field too, so its keys can't be theirs.
    expect(problem(WindowCommandId.Send, 'Alt+ArrowDown')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.NextTask,
    })
    expect(problem(WindowCommandId.PreviousTask, 'Enter')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(WindowCommandId.PreviousTask, 'Alt+Enter')).toBeNull()
  })

  it('lets keys be shared where they can’t both apply', () => {
    // The terminal keeps its keys: the task list's ⌥↑ / ⌥↓ don't reach it.
    expect(problem(WindowCommandId.ClearTerminal, 'Alt+ArrowDown')).toBeNull()
    expect(problem(WindowCommandId.NextTask, 'Meta+K')).toBeNull()
    expect(problem(WindowCommandId.NextTask, 'Alt+Enter')).toBeNull()
    expect(problem(WindowCommandId.EditLastQueued, 'ArrowDown')).toBeNull()
    expect(problem(WindowCommandId.ContextMenu, 'Meta+K')).toBeNull()
    expect(problem(WindowCommandId.ClearTerminal, 'Ctrl+Tab')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: WindowCommandId.NextTerminalTab,
    })
  })

  it('refuses keys that would type, for a shortcut that works in text fields too', () => {
    expect(problem(AppCommandId.NewTask, 'N')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(AppCommandId.NewTask, 'Shift+N')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(WindowCommandId.NextTask, 'ArrowDown')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(AppCommandId.NewTask, 'F4')).toBeNull()
    expect(problem(AppCommandId.NewTask, 'Alt+N')).toBeNull()
    expect(problem(AppCommandId.NewTask, 'Ctrl+N')).toBeNull()
    // The message field's own keys can be anything it doesn't already take.
    expect(problem(WindowCommandId.Send, 'Ctrl+Enter')).toBeNull()
    expect(problem(WindowCommandId.ContextMenu, 'F9')).toBeNull()
  })

  it('refuses a range bound to anything but a digit', () => {
    expect(problem(WorkspaceCommandId.Switch, 'Ctrl+A')).toEqual({
      kind: BindingProblemKind.NeedsDigit,
      digits: { from: 1, to: 9 },
    })
  })

  it('says why, as Settings › Keyboard shows it', () => {
    const say = (id: ShortcutId, stored: string): string => {
      const found = problem(id, stored)
      return found === null ? '' : describeBindingProblem(chord(stored), found)
    }
    expect(say(AppCommandId.NewTask, 'Meta+Q')).toBe('⌘Q is reserved for Quit Glade.')
    expect(say(AppCommandId.NewTask, 'Meta+Shift+P')).toBe('⌘⇧P is already used by Pin / unpin.')
    expect(say(AppCommandId.NewTask, 'Shift+N')).toBe('⇧N would type into text fields. Hold ⌘, ⌃ or ⌥ with it.')
    expect(say(WindowCommandId.ShowPanelTab, 'Meta+Alt+P')).toBe(
      'Press a number key with the modifiers to use for 1 – 5.',
    )
  })
})

describe('withBinding and withDefault', () => {
  it('store a changed binding, and drop it once it’s back at the default', () => {
    const changed = withBinding({}, AppCommandId.NewTask, chord('Meta+Shift+T'))
    expect(changed).toEqual({ [AppCommandId.NewTask]: 'Meta+Shift+T' })

    const both = withBinding(changed, TaskCommandId.MarkDone, chord('Ctrl+D'))
    expect(both).toEqual({ [AppCommandId.NewTask]: 'Meta+Shift+T', [TaskCommandId.MarkDone]: 'Ctrl+D' })

    expect(withBinding(both, AppCommandId.NewTask, chord('Meta+N'))).toEqual({ [TaskCommandId.MarkDone]: 'Ctrl+D' })
    expect(withDefault(both, TaskCommandId.MarkDone)).toEqual({ [AppCommandId.NewTask]: 'Meta+Shift+T' })
  })

  it('store a range by its modifiers, with its first digit', () => {
    expect(withBinding({}, WorkspaceCommandId.Switch, chord('Ctrl+6'))).toEqual({
      [WorkspaceCommandId.Switch]: 'Ctrl+1',
    })
    expect(withBinding({}, WorkspaceCommandId.Switch, chord('Meta+6'))).toEqual({})
  })
})

describe('formatBinding', () => {
  it('shows a chord, a range, part of a range, and a fixed command’s keys', () => {
    expect(formatBinding(TaskCommandId.TogglePin, DEFAULT_KEYMAP)).toBe('⌘⇧P')
    expect(formatBinding(WorkspaceCommandId.Switch, DEFAULT_KEYMAP)).toBe('⌘1 – ⌘9')
    expect(formatBinding(WindowCommandId.ShowPanelTab, DEFAULT_KEYMAP, { from: 4, to: 5 })).toBe('⌘⌥4–5')
    expect(formatBinding(WindowCommandId.SelectAnswer, DEFAULT_KEYMAP)).toBe('1 – 9')
    expect(formatBinding(WindowCommandId.MenuMove, DEFAULT_KEYMAP)).toBe('↑↓')
    expect(formatBinding(WorkspaceCommandId.Switch, resolveKeymap({ [WorkspaceCommandId.Switch]: 'Ctrl+Alt+1' }))).toBe(
      '⌃⌥1 – ⌃⌥9',
    )
  })
})

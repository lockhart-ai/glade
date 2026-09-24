import { describe, expect, it } from 'vitest'
import {
  bindingProblem,
  BindingProblemKind,
  chordFromEvent,
  CommandId,
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
} from './keymap'

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
    ['Meta+Shift+P', '⌘⇧P', 'Command+Shift+P'],
    ['Meta+Alt+ArrowDown', '⌘⌥↓', 'Command+Alt+Down'],
    ['Ctrl+Shift+Tab', '⌃⇧⇥', 'Control+Shift+Tab'],
    ['Ctrl+`', '⌃`', 'Control+`'],
    ['Shift+F10', '⇧F10', 'Shift+F10'],
    ['Enter', '↵', 'Enter'],
    ['Escape', 'Esc', 'Escape'],
    ['Alt+ArrowUp', '⌥↑', 'Alt+Up'],
    ['Meta+ArrowLeft', '⌘←', 'Command+Left'],
    ['Meta+ArrowRight', '⌘→', 'Command+Right'],
    ['Meta+Backspace', '⌘⌫', 'Command+Backspace'],
    ['Meta+Delete', '⌘⌦', 'Command+Delete'],
    ['Ctrl+Space', '⌃Space', 'Control+Space'],
    ['Meta++', '⌘+', 'Command+Plus'],
    ['Meta+,', '⌘,', 'Command+,'],
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
    expect(COMMANDS.map(({ id }) => id).sort()).toEqual(Object.values(CommandId).sort())
    const shown = KEYMAP_LAYOUT.flatMap(({ rows }) => rows.flatMap(({ keys }) => keys.map(({ command }) => command)))
    expect([...new Set(shown)].sort()).toEqual(Object.values(CommandId).sort())
    for (const group of KEYMAP_LAYOUT) {
      for (const row of group.rows) {
        for (const { command } of row.keys) expect(commandDefinition(command).area).toBe(group.area)
      }
    }
  })

  it('each take one binding you can change, but for the few fixed ones', () => {
    const fixed = COMMANDS.filter(({ id }) => !isRebindable(id)).map(({ id, fixed: reason }) => [id, reason])
    expect(fixed).toEqual([
      [CommandId.NewLine, FixedReason.TextField],
      [CommandId.CloseFileTab, FixedReason.Window],
      [CommandId.KillProcess, FixedReason.Shell],
      [CommandId.MenuMove, FixedReason.Menus],
      [CommandId.MenuChoose, FixedReason.Menus],
      [CommandId.MenuClose, FixedReason.Menus],
      [CommandId.SelectAnswer, FixedReason.Menus],
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
    const keymap = resolveKeymap({ [CommandId.NewTask]: 'Meta+Shift+T' })

    expect(keymap[CommandId.NewTask]).toEqual([chord('Meta+Shift+T')])
    expect(keymap[CommandId.MarkDone]).toEqual([chord('Meta+Shift+D')])
    expect(resolveKeymap({})).toEqual(DEFAULT_KEYMAP)
  })

  it('ignores a change that doesn’t parse, or is to a fixed command', () => {
    const keymap = resolveKeymap({ [CommandId.NewTask]: 'Meta+', [CommandId.CloseFileTab]: 'Meta+Shift+W' })

    expect(keymap).toEqual(DEFAULT_KEYMAP)
  })
})

describe('matchCommand', () => {
  const match = (id: CommandId, stored: string) =>
    matchCommand(commandDefinition(id), DEFAULT_KEYMAP[id], chord(stored))

  it('matches a command’s own chord, exactly', () => {
    expect(match(CommandId.MarkDone, 'Meta+Shift+D')).toEqual({ digit: null })
    expect(match(CommandId.MarkDone, 'Meta+D')).toBeNull()
    expect(match(CommandId.MarkDone, 'Meta+Alt+Shift+D')).toBeNull()
  })

  it('matches any digit of a range with its modifiers, and says which', () => {
    expect(match(CommandId.SwitchWorkspace, 'Meta+7')).toEqual({ digit: 7 })
    expect(match(CommandId.ShowPanelTab, 'Meta+Alt+5')).toEqual({ digit: 5 })
    expect(match(CommandId.ShowPanelTab, 'Meta+Alt+6')).toBeNull()
    expect(match(CommandId.SwitchWorkspace, 'Meta+0')).toBeNull()
    expect(match(CommandId.SwitchWorkspace, 'Meta+Shift+1')).toBeNull()
    expect(match(CommandId.SwitchWorkspace, 'Meta+K')).toBeNull()
  })

  it('matches either key of a command with two', () => {
    expect(match(CommandId.MenuMove, 'ArrowUp')).toEqual({ digit: null })
    expect(match(CommandId.MenuMove, 'ArrowDown')).toEqual({ digit: null })
  })
})

describe('bindingProblem', () => {
  const problem = (id: CommandId, stored: string) => bindingProblem(id, chord(stored), DEFAULT_KEYMAP)

  it.each(
    RESERVED_CHORDS.map(({ chord: reserved, owner }) => [formatChord(reserved), owner, serializeChord(reserved)]),
  )('refuses %s, which is %s’s', (_, owner, stored) => {
    expect(problem(CommandId.NewTask, stored)).toEqual({ kind: BindingProblemKind.Reserved, owner })
  })

  it('lets a range take its own digits, with other modifiers too', () => {
    expect(problem(CommandId.SwitchWorkspace, 'Meta+Shift+5')).toBeNull()
    expect(bindingProblem(CommandId.SwitchWorkspace, chord('Meta+1'), resolveKeymap({}))).toBeNull()
  })

  it('refuses keys another command has where both apply, a range’s digits included', () => {
    expect(problem(CommandId.NewTask, 'Meta+B')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.ToggleTaskList,
    })
    expect(problem(CommandId.NewTask, 'Meta+4')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.SwitchWorkspace,
    })
    expect(problem(CommandId.SwitchWorkspace, 'Meta+Shift+1')).toBeNull()
    expect(problem(CommandId.SwitchWorkspace, 'Meta+Alt+9')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.ShowPanelTab,
    })
    // The window's shortcuts reach the terminal, and the focused row.
    expect(problem(CommandId.NewTask, 'Ctrl+C')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.KillProcess,
    })
    expect(problem(CommandId.ContextMenu, 'Meta+J')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.ToggleBottomBar,
    })
    // The message field's own keys.
    expect(problem(CommandId.Send, 'Shift+Enter')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.NewLine,
    })
    expect(problem(CommandId.NextTask, 'Alt+ArrowUp')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.PreviousTask,
    })
  })

  it('lets keys be shared where they can’t both apply', () => {
    // The message field is a text field, where the task list's ⌥↑ / ⌥↓ don't reach.
    expect(problem(CommandId.Send, 'Alt+ArrowDown')).toBeNull()
    expect(problem(CommandId.NextTask, 'Alt+Enter')).toBeNull()
    expect(problem(CommandId.EditLastQueued, 'ArrowDown')).toBeNull()
    expect(problem(CommandId.ContextMenu, 'Meta+K')).toBeNull()
    expect(problem(CommandId.ClearTerminal, 'Ctrl+Tab')).toEqual({
      kind: BindingProblemKind.Conflict,
      command: CommandId.NextTerminalTab,
    })
  })

  it('refuses keys that would type, for a shortcut that works in text fields too', () => {
    expect(problem(CommandId.NewTask, 'N')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(CommandId.NewTask, 'Shift+N')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(CommandId.NextTask, 'ArrowDown')).toEqual({ kind: BindingProblemKind.NeedsModifier })
    expect(problem(CommandId.NewTask, 'F4')).toBeNull()
    expect(problem(CommandId.NewTask, 'Alt+N')).toBeNull()
    expect(problem(CommandId.NewTask, 'Ctrl+N')).toBeNull()
    // The message field's own keys can be anything it doesn't already take.
    expect(problem(CommandId.Send, 'Ctrl+Enter')).toBeNull()
    expect(problem(CommandId.ContextMenu, 'F9')).toBeNull()
  })

  it('refuses a range bound to anything but a digit', () => {
    expect(problem(CommandId.SwitchWorkspace, 'Ctrl+A')).toEqual({
      kind: BindingProblemKind.NeedsDigit,
      digits: { from: 1, to: 9 },
    })
  })

  it('says why, as Settings › Keyboard shows it', () => {
    const say = (id: CommandId, stored: string): string => {
      const found = problem(id, stored)
      return found === null ? '' : describeBindingProblem(chord(stored), found)
    }
    expect(say(CommandId.NewTask, 'Meta+Q')).toBe('⌘Q is reserved for Quit Glade.')
    expect(say(CommandId.NewTask, 'Meta+Shift+P')).toBe('⌘⇧P is already used by Pin / unpin.')
    expect(say(CommandId.NewTask, 'Shift+N')).toBe('⇧N would type into text fields. Hold ⌘, ⌃ or ⌥ with it.')
    expect(say(CommandId.ShowPanelTab, 'Meta+Alt+P')).toBe('Press a number key with the modifiers to use for 1 – 5.')
  })
})

describe('withBinding and withDefault', () => {
  it('store a changed binding, and drop it once it’s back at the default', () => {
    const changed = withBinding({}, CommandId.NewTask, chord('Meta+Shift+T'))
    expect(changed).toEqual({ [CommandId.NewTask]: 'Meta+Shift+T' })

    const both = withBinding(changed, CommandId.MarkDone, chord('Ctrl+D'))
    expect(both).toEqual({ [CommandId.NewTask]: 'Meta+Shift+T', [CommandId.MarkDone]: 'Ctrl+D' })

    expect(withBinding(both, CommandId.NewTask, chord('Meta+N'))).toEqual({ [CommandId.MarkDone]: 'Ctrl+D' })
    expect(withDefault(both, CommandId.MarkDone)).toEqual({ [CommandId.NewTask]: 'Meta+Shift+T' })
  })

  it('store a range by its modifiers, with its first digit', () => {
    expect(withBinding({}, CommandId.SwitchWorkspace, chord('Ctrl+6'))).toEqual({
      [CommandId.SwitchWorkspace]: 'Ctrl+1',
    })
    expect(withBinding({}, CommandId.SwitchWorkspace, chord('Meta+6'))).toEqual({})
  })
})

describe('formatBinding', () => {
  it('shows a chord, a range, part of a range, and a fixed command’s keys', () => {
    expect(formatBinding(CommandId.TogglePin, DEFAULT_KEYMAP)).toBe('⌘⇧P')
    expect(formatBinding(CommandId.SwitchWorkspace, DEFAULT_KEYMAP)).toBe('⌘1 – ⌘9')
    expect(formatBinding(CommandId.ShowPanelTab, DEFAULT_KEYMAP, { from: 4, to: 5 })).toBe('⌘⌥4–5')
    expect(formatBinding(CommandId.SelectAnswer, DEFAULT_KEYMAP)).toBe('1 – 9')
    expect(formatBinding(CommandId.MenuMove, DEFAULT_KEYMAP)).toBe('↑↓')
    expect(formatBinding(CommandId.SwitchWorkspace, resolveKeymap({ [CommandId.SwitchWorkspace]: 'Ctrl+Alt+1' }))).toBe(
      '⌃⌥1 – ⌃⌥9',
    )
  })
})

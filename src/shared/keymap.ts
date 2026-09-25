/**
 * The keymap (`docs/keymap.md`, `docs/design/screens/22-keymap.png`): the one table of every command that has a
 * shortcut (the commands are in `commands.ts`), its default binding, where it applies, who answers it and whether you
 * can rebind it (Settings › Keyboard). The menu bar's accelerators (main), the window's key dispatcher, Settings ›
 * Keyboard and every hint the window shows read it, so each shortcut is defined once and shows the same keys
 * everywhere.
 *
 * A binding is a chord: one key and the modifiers held with it. Bindings you change are stored as the `keyBindings`
 * setting, a chord string per command (`Meta+Shift+P`); the rest keep their defaults.
 */
import { AppCommandId, TaskCommandId, WindowCommandId, WorkspaceCommandId } from './commands'

/** One key and the modifiers held with it, e.g. ⌘⇧P. */
export interface KeyChord {
  /** The key: `A`–`Z`, `0`–`9`, a named key (`ArrowUp`, `Enter`, `F2`, `Tab`…) or the character it types (`,`). */
  readonly key: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

/** The modifiers, in the order a chord shows and stores them: ⌃⌘⌥⇧, the order `docs/keymap.md` writes them in. */
const MODIFIERS = [
  { flag: 'ctrl', name: 'Ctrl', glyph: '⌃', accelerator: 'Ctrl' },
  { flag: 'meta', name: 'Meta', glyph: '⌘', accelerator: 'CmdOrCtrl' },
  { flag: 'alt', name: 'Alt', glyph: '⌥', accelerator: 'Alt' },
  { flag: 'shift', name: 'Shift', glyph: '⇧', accelerator: 'Shift' },
] as const

/** How named keys show on a keycap. Any other key shows as its name (`F2`, `A`, `,`). */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Space: 'Space',
}

/** Electron's accelerator names for the named keys that differ from ours. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
}

/** A chord with no modifiers. */
function bare(key: string): KeyChord {
  return { key, ctrl: false, meta: false, alt: false, shift: false }
}

/** A chord as a keycap shows it, e.g. `⌘⇧P`, `⌥↓`, `F2`. */
export function formatChord(chord: KeyChord): string {
  const modifiers = MODIFIERS.filter(({ flag }) => chord[flag])
    .map(({ glyph }) => glyph)
    .join('')
  return modifiers + (KEY_GLYPHS[chord.key] ?? chord.key)
}

/** A chord as it's stored, e.g. `Meta+Shift+P`: its modifiers, then its key. */
export function serializeChord(chord: KeyChord): string {
  return [...MODIFIERS.filter(({ flag }) => chord[flag]).map(({ name }) => name), chord.key].join('+')
}

/** A chord as the menu bar's accelerator names it, e.g. `CmdOrCtrl+Shift+P`. */
export function toAccelerator(chord: KeyChord): Accelerator {
  return [
    ...MODIFIERS.filter(({ flag }) => chord[flag]).map(({ accelerator }) => accelerator),
    ACCELERATOR_KEYS[chord.key] ?? chord.key,
  ].join('+')
}

/** A stored chord (`serializeChord`), or null when it isn't one: modifiers, each at most once, then a key (`Meta++` is ⌘+). */
export function parseChord(text: string): KeyChord | null {
  const plusKey = text.endsWith('++')
  const parts = (plusKey ? text.slice(0, -2) : text).split('+')
  const key = plusKey ? '+' : parts.pop()
  if (key === undefined || key === '') return null
  const chord: { -readonly [K in keyof KeyChord]: KeyChord[K] } = bare(key)
  for (const name of parts.filter((part) => part !== '' || !plusKey)) {
    const modifier = MODIFIERS.find((candidate) => candidate.name === name)
    if (modifier === undefined || chord[modifier.flag]) return null
    chord[modifier.flag] = true
  }
  return chord
}

/** A chord written the way the defaults below are, e.g. `chord('Meta+Shift+P')`. Throws on a malformed one. */
function chord(text: string): KeyChord {
  const parsed = parseChord(text)
  if (parsed === null) throw new Error(`Malformed chord: ${text}`)
  return parsed
}

export function sameChord(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.meta === b.meta && a.alt === b.alt && a.shift === b.shift
}

/** Whether two chords hold the same modifiers, whatever their keys. */
function sameModifiers(a: KeyChord, b: KeyChord): boolean {
  return a.ctrl === b.ctrl && a.meta === b.meta && a.alt === b.alt && a.shift === b.shift
}

/** The keys that are only modifiers: pressed alone, they aren't a chord yet. */
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super'])

/** The letter or digit of a physical key (`KeyB` is B, `Digit2` is 2), or undefined for any other key. */
function physicalKey(code: string): string | undefined {
  return /^(?:Key|Digit)([A-Z0-9])$/.exec(code)?.[1]
}

/** What a key press is: the parts of a `KeyboardEvent` that make its chord. */
export interface KeyPress {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/**
 * The chord a key press makes, or null for a press of a modifier alone. A letter or digit reads the character it types
 * (`key`), so ⌘N follows your keyboard layout, except with ⌥ or ⇧ held: ⌥ changes the character on a Mac (⌥B types ∫)
 * and ⇧ does for digits (⇧1 types !), so then it reads the physical key (`code`). A letter reads in upper case (⌘⇧P
 * types P, ⌘P types p).
 */
export function chordFromEvent(event: KeyPress): KeyChord | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const physical = physicalKey(event.code)
  const typed = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
  const unreadable = typed === '' || typed === 'Unidentified' || typed === 'Dead'
  const key = (event.altKey || event.shiftKey || unreadable) && physical !== undefined ? physical : typed
  if (key === '' || key === 'Unidentified' || key === 'Dead') return null
  return { key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }
}

/** Whether a chord is an F-key, which types nothing, so it can go without a modifier anywhere. */
function isFunctionKey(chord: KeyChord): boolean {
  return /^F\d{1,2}$/.test(chord.key)
}

/** The areas of the keymap, as `docs/keymap.md` and Settings › Keyboard group it. */
export enum KeymapArea {
  Global = 'Global',
  TaskList = 'Task list',
  Chat = 'Chat',
  Panels = 'Panels',
  Terminal = 'Terminal',
  MenusAndDialogs = 'Menus and dialogs',
}

/** Every command that has a shortcut: the menu bar's that do, and the window's own. */
export type ShortcutId =
  | AppCommandId
  | WorkspaceCommandId.Switch
  | WorkspaceCommandId.Close
  | TaskCommandId.TogglePin
  | TaskCommandId.Rename
  | TaskCommandId.MarkUnread
  | TaskCommandId.MarkDone
  | WindowCommandId

/**
 * Where a command's shortcut applies, and who answers it: its "when". The menu bar answers its items' keys itself
 * (main builds its accelerators from this keymap), so the window never sees them; Window and MessageFieldOrOutsideTextFields
 * shortcuts go through the window's one key dispatcher; the others belong to the element that has the focus, which
 * reads the binding from here.
 */
export enum KeyScope {
  /** Anywhere in the window: the menu bar's item for the command answers it. */
  MenuBar = 'menu_bar',
  /** Anywhere in the window, typing in a text field included. */
  Window = 'window',
  /**
   * The message field, and anywhere that isn't a text field. Other text fields keep the keys, since there they edit the
   * text (⌥↑ moves the caret), and so does the terminal, whose field sends them to the shell.
   */
  MessageFieldOrOutsideTextFields = 'message_field_or_outside_text_fields',
  /** The focused item that has a context menu: a task's row, a reply, a file tab… */
  FocusedItem = 'focused_item',
  /** The chat's message field. */
  MessageField = 'message_field',
  /** The right panel, with the focus in it. */
  RightPanel = 'right_panel',
  /** The terminal, with the focus in it. */
  Terminal = 'terminal',
  /** An open menu or dialog. */
  OpenMenu = 'open_menu',
  /** A question card, with the focus in it. */
  QuestionCard = 'question_card',
}

/** The scopes the window's key dispatcher runs. */
export const DISPATCHED_SCOPES: readonly KeyScope[] = [KeyScope.Window, KeyScope.MessageFieldOrOutsideTextFields]

/** The scopes whose keys work wherever the focus is, so they mustn't type (see `bindingProblem`). */
const GLOBAL_SCOPES: readonly KeyScope[] = [KeyScope.MenuBar, ...DISPATCHED_SCOPES]

/** Why a command's binding can't be changed. */
export enum FixedReason {
  /** ⌘W is the menu bar's Close, which closes the window when no tab has the focus. */
  Window = 'window',
  /** The text field's own key. */
  TextField = 'text_field',
  /** The menus' and dialogs' own keys. */
  Menus = 'menus',
  /** The terminal passes it to the shell. */
  Shell = 'shell',
}

/** What each `FixedReason` says, as the keycap's tooltip in Settings › Keyboard. */
export const FIXED_REASONS: Readonly<Record<FixedReason, string>> = {
  [FixedReason.Window]: 'Fixed: ⌘W closes the window everywhere else',
  [FixedReason.TextField]: 'Fixed: the text field’s own key',
  [FixedReason.Menus]: 'Fixed: the menus’ and dialogs’ own keys',
  [FixedReason.Shell]: 'Fixed: the terminal sends it to the shell',
}

/** A run of digits a command takes, e.g. ⌘1 – ⌘9: the same modifiers with any of them. */
export interface DigitRange {
  readonly from: number
  readonly to: number
}

/** A command: its name, where it applies and its default binding. */
export interface CommandDefinition {
  readonly id: ShortcutId
  readonly area: KeymapArea
  /** What Settings › Keyboard and the menus call it. */
  readonly label: string
  readonly scope: KeyScope
  /**
   * Its default binding: one chord, or for a fixed command, the keys it takes (Move is ↑ and ↓). A command over a
   * digit range binds the range's first digit, e.g. ⌘1 for ⌘1 – ⌘9.
   */
  readonly defaults: readonly KeyChord[]
  /** For a command over a run of digits (⌘1 – ⌘9): which. Rebinding it changes the modifiers held with them. */
  readonly digits?: DigitRange
  /** Why it can't be rebound, for the few that can't; absent for the rest. */
  readonly fixed?: FixedReason
}

function command(
  id: ShortcutId,
  area: KeymapArea,
  label: string,
  scope: KeyScope,
  defaults: string | readonly string[],
  extra: Pick<CommandDefinition, 'digits' | 'fixed'> = {},
): CommandDefinition {
  return {
    id,
    area,
    label,
    scope,
    defaults: (typeof defaults === 'string' ? [defaults] : defaults).map(chord),
    ...extra,
  }
}

const NINE: DigitRange = { from: 1, to: 9 }
const { Global, TaskList, Chat, Panels, Terminal, MenusAndDialogs } = KeymapArea
const { MenuBar, Window, MessageFieldOrOutsideTextFields } = KeyScope

/** Every command, in `docs/keymap.md`'s order. */
export const COMMANDS: readonly CommandDefinition[] = [
  command(AppCommandId.NewTask, Global, 'New task', MenuBar, 'Meta+N'),
  command(WindowCommandId.JumpToTask, Global, 'Jump to task', Window, 'Meta+P'),
  command(WindowCommandId.SearchTasks, Global, 'Search tasks', Window, 'Meta+F'),
  command(AppCommandId.Settings, Global, 'Settings', MenuBar, 'Meta+,'),
  command(AppCommandId.NewWorkspace, Global, 'New workspace', MenuBar, 'Meta+Shift+N'),
  command(AppCommandId.OpenFolder, Global, 'Open folder as workspace', MenuBar, 'Meta+O'),
  command(WorkspaceCommandId.Switch, Global, 'Switch workspace', MenuBar, 'Meta+1', { digits: NINE }),
  command(WorkspaceCommandId.Close, Global, 'Close workspace', MenuBar, 'Meta+Shift+W'),
  command(WindowCommandId.NextTask, TaskList, 'Next task', MessageFieldOrOutsideTextFields, 'Alt+ArrowDown'),
  command(WindowCommandId.PreviousTask, TaskList, 'Previous task', MessageFieldOrOutsideTextFields, 'Alt+ArrowUp'),
  command(WindowCommandId.NextTaskNeedingYou, TaskList, 'Next task that needs you', Window, 'Meta+Alt+ArrowDown'),
  command(TaskCommandId.Rename, TaskList, 'Rename', MenuBar, 'F2'),
  command(TaskCommandId.TogglePin, TaskList, 'Pin / unpin', MenuBar, 'Meta+Shift+P'),
  command(TaskCommandId.MarkUnread, TaskList, 'Mark as unread', MenuBar, 'Meta+Shift+U'),
  command(TaskCommandId.MarkDone, TaskList, 'Mark done', MenuBar, 'Meta+Shift+D'),
  command(WindowCommandId.ContextMenu, TaskList, 'Context menu', KeyScope.FocusedItem, 'Shift+F10'),
  command(WindowCommandId.Send, Chat, 'Send (queues while working)', KeyScope.MessageField, 'Enter'),
  command(WindowCommandId.NewLine, Chat, 'New line', KeyScope.MessageField, 'Shift+Enter', {
    fixed: FixedReason.TextField,
  }),
  command(WindowCommandId.StopAgent, Chat, 'Stop the agent', Window, 'Meta+.'),
  command(WindowCommandId.CompactContext, Chat, 'Compact context', Window, 'Meta+Shift+K'),
  command(WindowCommandId.EditLastQueued, Chat, 'Edit last queued message', KeyScope.MessageField, 'ArrowUp'),
  command(WindowCommandId.FocusInput, Chat, 'Focus input', Window, 'Meta+L'),
  command(AppCommandId.ToggleSidebar, Panels, 'Toggle task list', MenuBar, 'Meta+B'),
  command(AppCommandId.ToggleRightPanel, Panels, 'Toggle right panel', MenuBar, 'Meta+Alt+B'),
  command(AppCommandId.ToggleBottomBar, Panels, 'Toggle bottom bar', MenuBar, 'Meta+J'),
  command(
    WindowCommandId.ShowPanelTab,
    Panels,
    'Tool calls · Files · Todos · Artifacts · Subagents',
    Window,
    'Meta+Alt+1',
    {
      digits: { from: 1, to: 5 },
    },
  ),
  command(AppCommandId.Close, Panels, 'Close file tab', MenuBar, 'Meta+W', {
    fixed: FixedReason.Window,
  }),
  command(WindowCommandId.OpenInEditor, Panels, 'Open file in editor', Window, 'Meta+Shift+E'),
  command(WindowCommandId.FocusTerminal, Terminal, 'Focus terminal', Window, 'Ctrl+`'),
  command(WindowCommandId.NewTerminalTab, Terminal, 'New terminal tab', Window, 'Meta+T'),
  command(WindowCommandId.NextTerminalTab, Terminal, 'Next tab', KeyScope.Terminal, 'Ctrl+Tab'),
  command(WindowCommandId.PreviousTerminalTab, Terminal, 'Previous tab', KeyScope.Terminal, 'Ctrl+Shift+Tab'),
  command(WindowCommandId.ClearTerminal, Terminal, 'Clear', KeyScope.Terminal, 'Meta+K'),
  command(WindowCommandId.KillProcess, Terminal, 'Kill process', KeyScope.Terminal, 'Ctrl+C', {
    fixed: FixedReason.Shell,
  }),
  command(WindowCommandId.MenuMove, MenusAndDialogs, 'Move', KeyScope.OpenMenu, ['ArrowUp', 'ArrowDown'], {
    fixed: FixedReason.Menus,
  }),
  command(WindowCommandId.MenuChoose, MenusAndDialogs, 'Choose', KeyScope.OpenMenu, 'Enter', {
    fixed: FixedReason.Menus,
  }),
  command(WindowCommandId.MenuClose, MenusAndDialogs, 'Close', KeyScope.OpenMenu, 'Escape', {
    fixed: FixedReason.Menus,
  }),
  command(
    WindowCommandId.SelectAnswer,
    MenusAndDialogs,
    'Select an answer in a question card',
    KeyScope.QuestionCard,
    '1',
    {
      digits: NINE,
      fixed: FixedReason.Menus,
    },
  ),
]

const BY_ID = new Map<string, CommandDefinition>(COMMANDS.map((definition) => [definition.id, definition]))

/** Whether a command has a shortcut: the menu bar's Reopen, say, has none. */
export function hasShortcut(id: string): id is ShortcutId {
  return BY_ID.has(id)
}

/** A command's definition. */
export function commandDefinition(id: ShortcutId): CommandDefinition {
  const definition = BY_ID.get(id)
  /* v8 ignore next -- every ShortcutId has a definition; keymap.test.ts checks it */
  if (definition === undefined) throw new Error(`No command ${id}`)
  return definition
}

/** The commands you can rebind: all but the fixed ones. */
export function isRebindable(id: ShortcutId): boolean {
  return commandDefinition(id).fixed === undefined
}

/**
 * Chords that are taken before a shortcut could have them: macOS's own (⌘Tab, ⌘Space), the app and Window menus' (⌘Q,
 * ⌘H, ⌘M), the Edit menu's, which every text field relies on, and the View menu's zoom and full screen. No command can
 * be bound to one. (⌘W is Close, a fixed command of the keymap's own.)
 */
export const RESERVED_CHORDS: readonly { readonly chord: KeyChord; readonly owner: string }[] = [
  { chord: chord('Meta+Q'), owner: 'Quit Glade' },
  { chord: chord('Meta+H'), owner: 'Hide Glade' },
  { chord: chord('Meta+Alt+H'), owner: 'Hide others' },
  { chord: chord('Meta+M'), owner: 'Minimize' },
  { chord: chord('Meta+Tab'), owner: 'macOS app switcher' },
  { chord: chord('Meta+Shift+Tab'), owner: 'macOS app switcher' },
  { chord: chord('Meta+Space'), owner: 'Spotlight' },
  { chord: chord('Meta+Z'), owner: 'Undo' },
  { chord: chord('Meta+Shift+Z'), owner: 'Redo' },
  { chord: chord('Meta+X'), owner: 'Cut' },
  { chord: chord('Meta+C'), owner: 'Copy' },
  { chord: chord('Meta+V'), owner: 'Paste' },
  { chord: chord('Meta+A'), owner: 'Select all' },
  { chord: chord('Meta+0'), owner: 'Actual size' },
  { chord: chord('Meta++'), owner: 'Zoom in' },
  { chord: chord('Meta+='), owner: 'Zoom in' },
  { chord: chord('Meta+-'), owner: 'Zoom out' },
  { chord: chord('Ctrl+Meta+F'), owner: 'Enter full screen' },
]

/** The bindings you've changed: a stored chord (`serializeChord`) for each command you've rebound. */
export type KeyBindingOverrides = Readonly<Partial<Record<ShortcutId, string>>>

/** Each command's binding as it now is: its override if you've rebound it, else its default. */
export type Keymap = Readonly<Record<ShortcutId, readonly KeyChord[]>>

/** The keymap with every command at its default. */
export const DEFAULT_KEYMAP: Keymap = resolveKeymap({})

/** The keymap with your changes: an override that doesn't parse, or is for a fixed command, is ignored. */
export function resolveKeymap(overrides: KeyBindingOverrides): Keymap {
  return Object.fromEntries(
    COMMANDS.map(({ id, defaults, fixed }) => {
      const override = fixed === undefined ? overrides[id] : undefined
      const parsed = override === undefined ? null : parseChord(override)
      return [id, parsed === null ? defaults : [parsed]]
    }),
  ) as Keymap
}

/** What a key press asks of a command: which digit of its range, for a command over a run of digits. */
export interface CommandMatch {
  /** The digit pressed (⌘3 is 3), or null for a command over no digits. */
  readonly digit: number | null
}

/** Whether a chord is one of a command's bindings, and if so which digit it presses; null when it isn't. */
export function matchCommand(
  definition: CommandDefinition,
  bindings: readonly KeyChord[],
  pressed: KeyChord,
): CommandMatch | null {
  const { digits } = definition
  for (const binding of bindings) {
    if (digits === undefined) {
      if (sameChord(binding, pressed)) return { digit: null }
      continue
    }
    const digit = /^\d$/.test(pressed.key) ? Number(pressed.key) : NaN
    if (sameModifiers(binding, pressed) && digit >= digits.from && digit <= digits.to) return { digit }
  }
  return null
}

/** An accelerator, as the menu bar takes it (`CmdOrCtrl+Shift+P`). */
export type Accelerator = string

/** The key of a command in `keymap`, as the menu bar's accelerator; for one over digits (⌘1 – ⌘9), with the nth digit. */
export function acceleratorOf(keymap: Keymap, id: ShortcutId, digit?: number): Accelerator | undefined {
  const [binding] = keymap[id]
  /* v8 ignore next -- every command in the keymap has a binding */
  if (binding === undefined) return undefined
  const range = commandDefinition(id).digits
  if (range === undefined) return toAccelerator(binding)
  if (digit === undefined || digit < range.from || digit > range.to) return undefined
  return toAccelerator({ ...binding, key: String(digit) })
}

/** Every chord a command takes: each of its bindings, or for a digit range, each digit with the range's modifiers. */
function expandedChords(definition: CommandDefinition, bindings: readonly KeyChord[]): KeyChord[] {
  const { digits } = definition
  if (digits === undefined) return [...bindings]
  return bindings.flatMap((binding) =>
    Array.from({ length: digits.to - digits.from + 1 }, (_, index) => ({
      ...binding,
      key: String(digits.from + index),
    })),
  )
}

/**
 * Whether one key press could reach both scopes. The menu bar's and the window's shortcuts reach the focus wherever it
 * is, except that one for the message field and outside text fields doesn't reach the terminal; the others each apply
 * only to their own element.
 */
function scopesOverlap(a: KeyScope, b: KeyScope): boolean {
  const anywhere: readonly KeyScope[] = [KeyScope.MenuBar, KeyScope.Window]
  if (a === b || anywhere.includes(a) || anywhere.includes(b)) return true
  if (a === KeyScope.MessageFieldOrOutsideTextFields) return b !== KeyScope.Terminal
  if (b === KeyScope.MessageFieldOrOutsideTextFields) return a !== KeyScope.Terminal
  return false
}

/** Why a chord can't be a command's binding. */
export enum BindingProblemKind {
  /** macOS or the app menu takes it first. */
  Reserved = 'reserved',
  /** Another command already has it where this one applies. */
  Conflict = 'conflict',
  /** A shortcut that works anywhere needs ⌘, ⌃ or ⌥ (or an F-key), or it would type into text fields. */
  NeedsModifier = 'needs_modifier',
  /** A command over a run of digits is bound by pressing one of them. */
  NeedsDigit = 'needs_digit',
}

export type BindingProblem =
  | { readonly kind: BindingProblemKind.Reserved; readonly owner: string }
  | { readonly kind: BindingProblemKind.Conflict; readonly command: ShortcutId }
  | { readonly kind: BindingProblemKind.NeedsModifier }
  | { readonly kind: BindingProblemKind.NeedsDigit; readonly digits: DigitRange }

/**
 * Why `chord` can't be the binding of command `id` in `keymap`, or null when it can. For a command over a run of
 * digits, `chord` is one of them pressed with the modifiers to use.
 */
export function bindingProblem(id: ShortcutId, chord: KeyChord, keymap: Keymap): BindingProblem | null {
  const definition = commandDefinition(id)
  const { digits } = definition
  if (digits !== undefined && !/^\d$/.test(chord.key)) return { kind: BindingProblemKind.NeedsDigit, digits }
  const bindings = [digits === undefined ? chord : { ...chord, key: String(digits.from) }]
  const chords = expandedChords(definition, bindings)
  const reserved = RESERVED_CHORDS.find((entry) => chords.some((candidate) => sameChord(candidate, entry.chord)))
  if (reserved !== undefined) return { kind: BindingProblemKind.Reserved, owner: reserved.owner }
  if (GLOBAL_SCOPES.includes(definition.scope) && !chord.meta && !chord.ctrl && !chord.alt && !isFunctionKey(chord))
    return { kind: BindingProblemKind.NeedsModifier }
  const other = COMMANDS.find(
    (candidate) =>
      candidate.id !== id &&
      scopesOverlap(candidate.scope, definition.scope) &&
      expandedChords(candidate, keymap[candidate.id]).some((taken) => chords.some((mine) => sameChord(mine, taken))),
  )
  return other === undefined ? null : { kind: BindingProblemKind.Conflict, command: other.id }
}

/** What a binding problem says, inline under the shortcut you tried, e.g. "⌘⇧P is already used by Pin / unpin." */
export function describeBindingProblem(chord: KeyChord, problem: BindingProblem): string {
  const keys = formatChord(chord)
  switch (problem.kind) {
    case BindingProblemKind.Reserved:
      return `${keys} is reserved for ${problem.owner}.`
    case BindingProblemKind.Conflict:
      return `${keys} is already used by ${commandDefinition(problem.command).label}.`
    case BindingProblemKind.NeedsModifier:
      return `${keys} would type into text fields. Hold ⌘, ⌃ or ⌥ with it.`
    case BindingProblemKind.NeedsDigit:
      return `Press a number key with the modifiers to use for ${String(problem.digits.from)} – ${String(problem.digits.to)}.`
  }
}

/** The overrides once command `id` is bound to `chord`: none for it when that's its default. */
export function withBinding(overrides: KeyBindingOverrides, id: ShortcutId, chord: KeyChord): KeyBindingOverrides {
  const definition = commandDefinition(id)
  const { digits } = definition
  const binding = digits === undefined ? chord : { ...chord, key: String(digits.from) }
  if (definition.defaults.some((fallback) => sameChord(fallback, binding))) return withDefault(overrides, id)
  return { ...overrides, [id]: serializeChord(binding) }
}

/** The overrides once command `id` is back at its default. */
export function withDefault(overrides: KeyBindingOverrides, id: ShortcutId): KeyBindingOverrides {
  return Object.fromEntries((Object.entries(overrides) as [ShortcutId, string][]).filter(([key]) => key !== id))
}

/**
 * How a command's binding shows: `⌘⇧P`; a digit range as `⌘1 – ⌘9`, or with `digits`, part of it as `⌘⌥1–3`; a
 * fixed command's keys run together (`↑↓`).
 */
export function formatBinding(id: ShortcutId, keymap: Keymap, digits?: DigitRange): string {
  const definition = commandDefinition(id)
  const bindings = keymap[id]
  const range = definition.digits
  if (range === undefined) return bindings.map(formatChord).join('')
  const [binding] = bindings
  /* v8 ignore next -- a digit range always has its one binding */
  if (binding === undefined) return ''
  const modifiers = formatChord({ ...binding, key: '' })
  if (digits !== undefined) return `${modifiers}${String(digits.from)}–${String(digits.to)}`
  return `${modifiers}${String(range.from)} – ${modifiers}${String(range.to)}`
}

/** One keycap of a row in Settings › Keyboard: a command, or for a digit range, the part of it the row is about. */
export interface KeymapKey {
  readonly command: ShortcutId
  readonly digits?: DigitRange
}

/** One row of Settings › Keyboard: what it does and its keycaps. */
export interface KeymapRow {
  readonly action: string
  readonly keys: readonly KeymapKey[]
}

/** The rows of one area. */
export interface KeymapGroup {
  readonly area: KeymapArea
  readonly rows: readonly KeymapRow[]
}

/** A row with one keycap per command. */
function row(action: string, ...commands: ShortcutId[]): KeymapRow {
  return { action, keys: commands.map((id) => ({ command: id })) }
}

/**
 * Settings › Keyboard's rows, laid out as `22-keymap.png` lays them out: pairs share a row (Next / previous task), and
 * the right panel's tabs split over two.
 */
export const KEYMAP_LAYOUT: readonly KeymapGroup[] = [
  {
    area: Global,
    rows: [
      row('New task', AppCommandId.NewTask),
      row('Jump to task', WindowCommandId.JumpToTask),
      row('Search tasks', WindowCommandId.SearchTasks),
      row('Settings', AppCommandId.Settings),
      row('New workspace', AppCommandId.NewWorkspace),
      row('Open folder as workspace', AppCommandId.OpenFolder),
      row('Switch workspace', WorkspaceCommandId.Switch),
      row('Close workspace', WorkspaceCommandId.Close),
    ],
  },
  {
    area: TaskList,
    rows: [
      row('Next / previous task', WindowCommandId.NextTask, WindowCommandId.PreviousTask),
      row('Next task that needs you', WindowCommandId.NextTaskNeedingYou),
      row('Rename', TaskCommandId.Rename),
      row('Pin / unpin', TaskCommandId.TogglePin),
      row('Mark as unread', TaskCommandId.MarkUnread),
      row('Mark done', TaskCommandId.MarkDone),
      row('Context menu', WindowCommandId.ContextMenu),
    ],
  },
  {
    area: Chat,
    rows: [
      row('Send (queues while working)', WindowCommandId.Send),
      row('New line', WindowCommandId.NewLine),
      row('Stop the agent', WindowCommandId.StopAgent),
      row('Compact context', WindowCommandId.CompactContext),
      row('Edit last queued message', WindowCommandId.EditLastQueued),
      row('Focus input', WindowCommandId.FocusInput),
    ],
  },
  {
    area: Panels,
    rows: [
      row('Toggle task list', AppCommandId.ToggleSidebar),
      row('Toggle right panel', AppCommandId.ToggleRightPanel),
      row('Toggle bottom bar', AppCommandId.ToggleBottomBar),
      {
        action: 'Tool calls · Files · Todos',
        keys: [{ command: WindowCommandId.ShowPanelTab, digits: { from: 1, to: 3 } }],
      },
      {
        action: 'Artifacts · Subagents',
        keys: [{ command: WindowCommandId.ShowPanelTab, digits: { from: 4, to: 5 } }],
      },
      row('Close file tab', AppCommandId.Close),
      row('Open file in editor', WindowCommandId.OpenInEditor),
    ],
  },
  {
    area: Terminal,
    rows: [
      row('Focus terminal', WindowCommandId.FocusTerminal),
      row('New terminal tab', WindowCommandId.NewTerminalTab),
      row('Next / previous tab', WindowCommandId.NextTerminalTab, WindowCommandId.PreviousTerminalTab),
      row('Clear', WindowCommandId.ClearTerminal),
      row('Kill process', WindowCommandId.KillProcess),
    ],
  },
  {
    area: MenusAndDialogs,
    rows: [
      row('Move', WindowCommandId.MenuMove),
      row('Choose', WindowCommandId.MenuChoose),
      row('Close', WindowCommandId.MenuClose),
      row('Select an answer in a question card', WindowCommandId.SelectAnswer),
    ],
  },
]

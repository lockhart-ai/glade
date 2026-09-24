/**
 * The keymap (`docs/keymap.md`, `docs/design/screens/22-keymap.png`): every command that has a shortcut, its default
 * binding, where it applies, and whether you can rebind it (Settings › Keyboard). Main reads it for the menu bar's
 * accelerators and the renderer for its key dispatcher, Settings › Keyboard and the context menus' hints, so each
 * shortcut is defined once and shows the same binding everywhere.
 *
 * A binding is a chord: one key and the modifiers held with it. Bindings you change are stored as the `keyBindings`
 * setting, a chord string per command (`Meta+Shift+P`); the rest keep their defaults.
 */

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
  { flag: 'ctrl', name: 'Ctrl', glyph: '⌃', accelerator: 'Control' },
  { flag: 'meta', name: 'Meta', glyph: '⌘', accelerator: 'Command' },
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

/** A chord as the menu bar's accelerator names it, e.g. `Command+Shift+P`. */
export function toAccelerator(chord: KeyChord): string {
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

/** Every command that has a shortcut. */
export enum CommandId {
  NewTask = 'new_task',
  JumpToTask = 'jump_to_task',
  SearchTasks = 'search_tasks',
  OpenSettings = 'open_settings',
  NewWorkspace = 'new_workspace',
  OpenFolderAsWorkspace = 'open_folder_as_workspace',
  SwitchWorkspace = 'switch_workspace',
  NextTask = 'next_task',
  PreviousTask = 'previous_task',
  NextTaskNeedingYou = 'next_task_needing_you',
  RenameTask = 'rename_task',
  TogglePin = 'toggle_pin',
  MarkUnread = 'mark_unread',
  MarkDone = 'mark_done',
  ContextMenu = 'context_menu',
  Send = 'send',
  NewLine = 'new_line',
  StopAgent = 'stop_agent',
  CompactContext = 'compact_context',
  EditLastQueued = 'edit_last_queued',
  FocusInput = 'focus_input',
  ToggleTaskList = 'toggle_task_list',
  ToggleRightPanel = 'toggle_right_panel',
  ToggleBottomBar = 'toggle_bottom_bar',
  ShowPanelTab = 'show_panel_tab',
  CloseFileTab = 'close_file_tab',
  OpenInEditor = 'open_in_editor',
  FocusTerminal = 'focus_terminal',
  NewTerminalTab = 'new_terminal_tab',
  NextTerminalTab = 'next_terminal_tab',
  PreviousTerminalTab = 'previous_terminal_tab',
  ClearTerminal = 'clear_terminal',
  KillProcess = 'kill_process',
  MenuMove = 'menu_move',
  MenuChoose = 'menu_choose',
  MenuClose = 'menu_close',
  SelectAnswer = 'select_answer',
}

/**
 * Where a command's shortcut applies: its "when". Window and OutsideTextFields shortcuts go through the window's one
 * key dispatcher; the others belong to the element that has the focus, which reads the binding from here.
 */
export enum KeyScope {
  /** Anywhere in the window, typing in a text field included. */
  Window = 'window',
  /** Anywhere but a text field, where the keys edit the text instead (⌥↑ moves the caret). */
  OutsideTextFields = 'outside_text_fields',
  /** The focused item that has a context menu: a task's row, a reply, a file tab… */
  FocusedItem = 'focused_item',
  /** The chat's message field. */
  MessageField = 'message_field',
  /** The right panel, with the focus in it. */
  RightPanel = 'right_panel',
  /** The terminal, with the focus in it. */
  Terminal = 'terminal',
  /** An open menu or dialog. */
  Menu = 'menu',
  /** A question card, with the focus in it. */
  QuestionCard = 'question_card',
}

/** The scopes the window's key dispatcher runs. */
export const DISPATCHED_SCOPES: readonly KeyScope[] = [KeyScope.Window, KeyScope.OutsideTextFields]

/** Why a command's binding can't be changed. */
export enum FixedReason {
  /** ⌘W closes the window anywhere else, which macOS handles before a shortcut could be recorded. */
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
  readonly id: CommandId
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
  id: CommandId,
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
const { Window, OutsideTextFields } = KeyScope

/** Every command, in `docs/keymap.md`'s order. */
export const COMMANDS: readonly CommandDefinition[] = [
  command(CommandId.NewTask, Global, 'New task', Window, 'Meta+N'),
  command(CommandId.JumpToTask, Global, 'Jump to task', Window, 'Meta+P'),
  command(CommandId.SearchTasks, Global, 'Search tasks', Window, 'Meta+F'),
  command(CommandId.OpenSettings, Global, 'Settings', Window, 'Meta+,'),
  command(CommandId.NewWorkspace, Global, 'New workspace', Window, 'Meta+Shift+N'),
  command(CommandId.OpenFolderAsWorkspace, Global, 'Open folder as workspace', Window, 'Meta+O'),
  command(CommandId.SwitchWorkspace, Global, 'Switch workspace', Window, 'Meta+1', { digits: NINE }),
  command(CommandId.NextTask, TaskList, 'Next task', OutsideTextFields, 'Alt+ArrowDown'),
  command(CommandId.PreviousTask, TaskList, 'Previous task', OutsideTextFields, 'Alt+ArrowUp'),
  command(CommandId.NextTaskNeedingYou, TaskList, 'Next task that needs you', Window, 'Meta+Alt+ArrowDown'),
  command(CommandId.RenameTask, TaskList, 'Rename', Window, 'F2'),
  command(CommandId.TogglePin, TaskList, 'Pin / unpin', Window, 'Meta+Shift+P'),
  command(CommandId.MarkUnread, TaskList, 'Mark as unread', Window, 'Meta+Shift+U'),
  command(CommandId.MarkDone, TaskList, 'Mark done', Window, 'Meta+Shift+D'),
  command(CommandId.ContextMenu, TaskList, 'Context menu', KeyScope.FocusedItem, 'Shift+F10'),
  command(CommandId.Send, Chat, 'Send (queues while working)', KeyScope.MessageField, 'Enter'),
  command(CommandId.NewLine, Chat, 'New line', KeyScope.MessageField, 'Shift+Enter', { fixed: FixedReason.TextField }),
  command(CommandId.StopAgent, Chat, 'Stop the agent', Window, 'Meta+.'),
  command(CommandId.CompactContext, Chat, 'Compact context', Window, 'Meta+Shift+K'),
  command(CommandId.EditLastQueued, Chat, 'Edit last queued message', KeyScope.MessageField, 'ArrowUp'),
  command(CommandId.FocusInput, Chat, 'Focus input', Window, 'Meta+L'),
  command(CommandId.ToggleTaskList, Panels, 'Toggle task list', Window, 'Meta+B'),
  command(CommandId.ToggleRightPanel, Panels, 'Toggle right panel', Window, 'Meta+Alt+B'),
  command(CommandId.ToggleBottomBar, Panels, 'Toggle bottom bar', Window, 'Meta+J'),
  command(CommandId.ShowPanelTab, Panels, 'Tool calls · Files · Todos · Artifacts · Subagents', Window, 'Meta+Alt+1', {
    digits: { from: 1, to: 5 },
  }),
  command(CommandId.CloseFileTab, Panels, 'Close file tab', KeyScope.RightPanel, 'Meta+W', {
    fixed: FixedReason.Window,
  }),
  command(CommandId.OpenInEditor, Panels, 'Open file in editor', Window, 'Meta+Shift+E'),
  command(CommandId.FocusTerminal, Terminal, 'Focus terminal', Window, 'Ctrl+`'),
  command(CommandId.NewTerminalTab, Terminal, 'New terminal tab', Window, 'Meta+T'),
  command(CommandId.NextTerminalTab, Terminal, 'Next tab', KeyScope.Terminal, 'Ctrl+Tab'),
  command(CommandId.PreviousTerminalTab, Terminal, 'Previous tab', KeyScope.Terminal, 'Ctrl+Shift+Tab'),
  command(CommandId.ClearTerminal, Terminal, 'Clear', KeyScope.Terminal, 'Meta+K'),
  command(CommandId.KillProcess, Terminal, 'Kill process', KeyScope.Terminal, 'Ctrl+C', { fixed: FixedReason.Shell }),
  command(CommandId.MenuMove, MenusAndDialogs, 'Move', KeyScope.Menu, ['ArrowUp', 'ArrowDown'], {
    fixed: FixedReason.Menus,
  }),
  command(CommandId.MenuChoose, MenusAndDialogs, 'Choose', KeyScope.Menu, 'Enter', { fixed: FixedReason.Menus }),
  command(CommandId.MenuClose, MenusAndDialogs, 'Close', KeyScope.Menu, 'Escape', { fixed: FixedReason.Menus }),
  command(CommandId.SelectAnswer, MenusAndDialogs, 'Select an answer in a question card', KeyScope.QuestionCard, '1', {
    digits: NINE,
    fixed: FixedReason.Menus,
  }),
]

const BY_ID = new Map(COMMANDS.map((definition) => [definition.id, definition]))

/** A command's definition. */
export function commandDefinition(id: CommandId): CommandDefinition {
  const definition = BY_ID.get(id)
  /* v8 ignore next -- every CommandId has a definition; keymap.test.ts checks it */
  if (definition === undefined) throw new Error(`No command ${id}`)
  return definition
}

/** The commands you can rebind: all but the fixed ones. */
export function isRebindable(id: CommandId): boolean {
  return commandDefinition(id).fixed === undefined
}

/**
 * Chords that are taken before a shortcut could have them: macOS's own (⌘Tab, ⌘Space), the app menu's (⌘Q, ⌘H, ⌘M)
 * and the window's (⌘W), and the Edit menu's, which every text field relies on. No command can be bound to one.
 */
export const RESERVED_CHORDS: readonly { readonly chord: KeyChord; readonly owner: string }[] = [
  { chord: chord('Meta+Q'), owner: 'Quit Glade' },
  { chord: chord('Meta+W'), owner: 'Close window' },
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
]

/** The bindings you've changed: a stored chord (`serializeChord`) for each command you've rebound. */
export type KeyBindingOverrides = Readonly<Partial<Record<CommandId, string>>>

/** Each command's binding as it now is: its override if you've rebound it, else its default. */
export type Keymap = Readonly<Record<CommandId, readonly KeyChord[]>>

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
 * Whether one key press could reach both scopes. The window's shortcuts reach the focus wherever it is, except that
 * one outside text fields doesn't reach the message field; the others each apply only to their own element.
 */
function scopesOverlap(a: KeyScope, b: KeyScope): boolean {
  if (a === b || a === KeyScope.Window || b === KeyScope.Window) return true
  if (a === KeyScope.OutsideTextFields) return b !== KeyScope.MessageField
  if (b === KeyScope.OutsideTextFields) return a !== KeyScope.MessageField
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
  | { readonly kind: BindingProblemKind.Conflict; readonly command: CommandId }
  | { readonly kind: BindingProblemKind.NeedsModifier }
  | { readonly kind: BindingProblemKind.NeedsDigit; readonly digits: DigitRange }

/**
 * Why `chord` can't be the binding of command `id` in `keymap`, or null when it can. For a command over a run of
 * digits, `chord` is one of them pressed with the modifiers to use.
 */
export function bindingProblem(id: CommandId, chord: KeyChord, keymap: Keymap): BindingProblem | null {
  const definition = commandDefinition(id)
  const { digits } = definition
  if (digits !== undefined && !/^\d$/.test(chord.key)) return { kind: BindingProblemKind.NeedsDigit, digits }
  const bindings = [digits === undefined ? chord : { ...chord, key: String(digits.from) }]
  const chords = expandedChords(definition, bindings)
  const reserved = RESERVED_CHORDS.find((entry) => chords.some((candidate) => sameChord(candidate, entry.chord)))
  if (reserved !== undefined) return { kind: BindingProblemKind.Reserved, owner: reserved.owner }
  if (DISPATCHED_SCOPES.includes(definition.scope) && !chord.meta && !chord.ctrl && !chord.alt && !isFunctionKey(chord))
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
export function withBinding(overrides: KeyBindingOverrides, id: CommandId, chord: KeyChord): KeyBindingOverrides {
  const definition = commandDefinition(id)
  const { digits } = definition
  const binding = digits === undefined ? chord : { ...chord, key: String(digits.from) }
  if (definition.defaults.some((fallback) => sameChord(fallback, binding))) return withDefault(overrides, id)
  return { ...overrides, [id]: serializeChord(binding) }
}

/** The overrides once command `id` is back at its default. */
export function withDefault(overrides: KeyBindingOverrides, id: CommandId): KeyBindingOverrides {
  return Object.fromEntries((Object.entries(overrides) as [CommandId, string][]).filter(([key]) => key !== id))
}

/**
 * How a command's binding shows: `⌘⇧P`; a digit range as `⌘1 – ⌘9`, or with `digits`, part of it as `⌘⌥1–3`; a
 * fixed command's keys run together (`↑↓`).
 */
export function formatBinding(id: CommandId, keymap: Keymap, digits?: DigitRange): string {
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
  readonly command: CommandId
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
function row(action: string, ...commands: CommandId[]): KeymapRow {
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
      row('New task', CommandId.NewTask),
      row('Jump to task', CommandId.JumpToTask),
      row('Search tasks', CommandId.SearchTasks),
      row('Settings', CommandId.OpenSettings),
      row('New workspace', CommandId.NewWorkspace),
      row('Open folder as workspace', CommandId.OpenFolderAsWorkspace),
      row('Switch workspace', CommandId.SwitchWorkspace),
    ],
  },
  {
    area: TaskList,
    rows: [
      row('Next / previous task', CommandId.NextTask, CommandId.PreviousTask),
      row('Next task that needs you', CommandId.NextTaskNeedingYou),
      row('Rename', CommandId.RenameTask),
      row('Pin / unpin', CommandId.TogglePin),
      row('Mark as unread', CommandId.MarkUnread),
      row('Mark done', CommandId.MarkDone),
      row('Context menu', CommandId.ContextMenu),
    ],
  },
  {
    area: Chat,
    rows: [
      row('Send (queues while working)', CommandId.Send),
      row('New line', CommandId.NewLine),
      row('Stop the agent', CommandId.StopAgent),
      row('Compact context', CommandId.CompactContext),
      row('Edit last queued message', CommandId.EditLastQueued),
      row('Focus input', CommandId.FocusInput),
    ],
  },
  {
    area: Panels,
    rows: [
      row('Toggle task list', CommandId.ToggleTaskList),
      row('Toggle right panel', CommandId.ToggleRightPanel),
      row('Toggle bottom bar', CommandId.ToggleBottomBar),
      { action: 'Tool calls · Files · Todos', keys: [{ command: CommandId.ShowPanelTab, digits: { from: 1, to: 3 } }] },
      { action: 'Artifacts · Subagents', keys: [{ command: CommandId.ShowPanelTab, digits: { from: 4, to: 5 } }] },
      row('Close file tab', CommandId.CloseFileTab),
      row('Open file in editor', CommandId.OpenInEditor),
    ],
  },
  {
    area: Terminal,
    rows: [
      row('Focus terminal', CommandId.FocusTerminal),
      row('New terminal tab', CommandId.NewTerminalTab),
      row('Next / previous tab', CommandId.NextTerminalTab, CommandId.PreviousTerminalTab),
      row('Clear', CommandId.ClearTerminal),
      row('Kill process', CommandId.KillProcess),
    ],
  },
  {
    area: MenusAndDialogs,
    rows: [
      row('Move', CommandId.MenuMove),
      row('Choose', CommandId.MenuChoose),
      row('Close', CommandId.MenuClose),
      row('Select an answer in a question card', CommandId.SelectAnswer),
    ],
  },
]

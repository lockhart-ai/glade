import {
  chordFromEvent,
  COMMANDS,
  DISPATCHED_SCOPES,
  KeyScope,
  matchCommand,
  resolveKeymap,
  type ShortcutId,
  type CommandMatch,
  type KeyBindingOverrides,
  type Keymap,
} from '../../shared/keymap'
import type { GladeStore } from '../store/store'

/** Runs a command: for one over a run of digits (⌘1 – ⌘9), the digit pressed. */
export type CommandHandler = (match: CommandMatch) => void

/** What running a command from somewhere other than its keys (a menu) asks: no digit. */
export const NO_DIGIT: CommandMatch = { digit: null }

/** Whether keys typed into this element edit text, so shortcuts outside text fields (⌥↑, ⌥↓) belong to it instead. */
export function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  )
}

/**
 * The window's commands and its one key dispatcher. Components register the commands they can run (`useCommands`);
 * while any are registered, one `keydown` listener on the window matches each key press against the current keymap
 * (the defaults and the bindings you've changed, from the store's settings) and runs the command it's bound to. A
 * match is the app's, so the key's default action is prevented, even when the command has nothing to do (⌘⇧D with no
 * task selected). The same command registered twice runs where it was registered last.
 */
export class CommandRegistry {
  private readonly handlers = new Map<ShortcutId, CommandHandler[]>()
  private cached: { readonly overrides: KeyBindingOverrides; readonly keymap: Keymap } | null = null

  constructor(private readonly store: GladeStore) {}

  /** The keymap as it now is. */
  keymap(): Keymap {
    const overrides = this.store.getState().settings.keyBindings
    if (this.cached?.overrides !== overrides) this.cached = { overrides, keymap: resolveKeymap(overrides) }
    return this.cached.keymap
  }

  /** Registers a handler for a command, until the returned function is called. */
  register(id: ShortcutId, handler: CommandHandler): () => void {
    if (this.handlers.size === 0) window.addEventListener('keydown', this.onKeyDown)
    this.handlers.set(id, [...(this.handlers.get(id) ?? []), handler])
    return () => {
      const remaining = (this.handlers.get(id) ?? []).filter((candidate) => candidate !== handler)
      if (remaining.length > 0) this.handlers.set(id, remaining)
      else this.handlers.delete(id)
      if (this.handlers.size === 0) window.removeEventListener('keydown', this.onKeyDown)
    }
  }

  /** Whether something mounted can run the command just now. */
  has(id: ShortcutId): boolean {
    return this.handlers.has(id)
  }

  /** Runs a command as its keys would (a menu item's click, say); false when nothing registered can run it. */
  run(id: ShortcutId, match: CommandMatch = NO_DIGIT): boolean {
    const handler = this.handlers.get(id)?.at(-1)
    if (handler === undefined) return false
    handler(match)
    return true
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const pressed = chordFromEvent(event)
    if (pressed === null) return
    const keymap = this.keymap()
    for (const definition of COMMANDS) {
      if (!DISPATCHED_SCOPES.includes(definition.scope) || !this.handlers.has(definition.id)) continue
      const match = matchCommand(definition, keymap[definition.id], pressed)
      if (match === null) continue
      if (definition.scope === KeyScope.OutsideTextFields && isTextField(event.target)) continue
      event.preventDefault()
      this.run(definition.id, match)
      return
    }
  }
}

const registries = new WeakMap<GladeStore, CommandRegistry>()

/** The command registry of the window whose store this is. */
export function commandRegistry(store: GladeStore): CommandRegistry {
  let registry = registries.get(store)
  if (registry === undefined) {
    registry = new CommandRegistry(store)
    registries.set(store, registry)
  }
  return registry
}

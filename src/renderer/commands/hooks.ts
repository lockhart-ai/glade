import { useEffect, useMemo, useRef } from 'react'
import {
  CommandId,
  DEFAULT_KEYMAP,
  formatBinding,
  matchCommand,
  commandDefinition,
  resolveKeymap,
  chordFromEvent,
  serializeChord,
  type Keymap,
  type KeyPress,
} from '../../shared/keymap'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { commandRegistry, type CommandHandler } from './registry'

export type { CommandHandler } from './registry'

/** The handlers a component registers: null (or left out) for a command it can't run just now. */
export type CommandHandlers = Partial<Record<CommandId, CommandHandler | null>>

/**
 * Registers commands with the window's key dispatcher (`CommandRegistry`) while the component is mounted: pressing a
 * command's binding runs its handler. A command whose handler is null isn't registered, so its keys do what they
 * otherwise would. The handlers can change on every render; what's registered changes only when which commands have
 * one does.
 */
export function useCommands(handlers: CommandHandlers): void {
  const store = useGladeStoreApi()
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  const ids = Object.values(CommandId)
    .filter((id) => handlers[id] != null)
    .join(' ')
  useEffect(() => {
    const registry = commandRegistry(store)
    const removals = (ids === '' ? [] : (ids.split(' ') as CommandId[])).map((id) =>
      registry.register(id, (match) => {
        latest.current[id]?.(match)
      }),
    )
    return () => {
      for (const remove of removals) remove()
    }
  }, [store, ids])
}

/** Registers one command's handler (see `useCommands`). */
export function useCommand(id: CommandId, handler: CommandHandler | null): void {
  useCommands({ [id]: handler })
}

/** The keymap as it now is: the defaults, and the bindings you've changed in Settings › Keyboard. */
export function useKeymap(): Keymap {
  const overrides = useGladeStore((state) => state.settings.keyBindings)
  return useMemo(() => resolveKeymap(overrides), [overrides])
}

/** A command's current binding, for a hint beside a button or menu item. */
export interface BindingHint {
  /** As a keycap shows it, e.g. `⌘⇧P`. */
  readonly label: string
  /** As `aria-keyshortcuts` names it, e.g. `Meta+Shift+P`. */
  readonly ariaKeyShortcuts: string
}

/** A command's binding in a keymap (the defaults, unless you pass another), for a hint. */
export function bindingHint(id: CommandId, keymap: Keymap = DEFAULT_KEYMAP): BindingHint {
  return { label: formatBinding(id, keymap), ariaKeyShortcuts: keymap[id].map(serializeChord).join(' ') }
}

/** A command's current binding, for a hint beside a button or menu item. */
export function useBinding(id: CommandId): BindingHint {
  return bindingHint(id, useKeymap())
}

/**
 * Whether a key press is a command's current binding, for the commands the focused element handles itself (the
 * message field's ↵, a row's ⇧F10).
 */
export function isCommandKey(id: CommandId, keymap: Keymap, event: KeyPress): boolean {
  const pressed = chordFromEvent(event)
  return pressed !== null && matchCommand(commandDefinition(id), keymap[id], pressed) !== null
}

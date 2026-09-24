import { useEffect } from 'react'
import type { MenuState } from '../../shared/commands'
import { useGladeStore } from '../store/react'
import { menuStateOf } from './menuState'
import { useCommandRunner } from './useCommandRunner'

/**
 * Keeps the macOS menu bar in step with the window: tells main what it shows whenever that changes (`menu.update`),
 * and runs the commands main sends back when you choose an item or press its key (`menu.command`). The menu bar
 * answers its items' keys itself, so nothing in the window listens for them: each runs once. Renders nothing. Must be
 * used under a `ToastProvider`.
 */
export function MenuBar(): null {
  // Serialized, so the selector's value only changes when what the menu bar shows does.
  const menuState = useGladeStore((state) => JSON.stringify(menuStateOf(state)))
  const updateMenu = useGladeStore((state) => state.updateMenu)
  const onCommand = useGladeStore((state) => state.onCommand)
  const runCommand = useCommandRunner()

  useEffect(() => {
    void updateMenu(JSON.parse(menuState) as MenuState)
  }, [menuState, updateMenu])

  useEffect(() => onCommand(runCommand), [onCommand, runCommand])

  return null
}

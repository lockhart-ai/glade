import { useEffect } from 'react'
import { useGladeStore } from '../store/react'
import { workspaceAt } from '../workspace-switcher/switcherModel'
import { useWorkspaceActions } from '../workspace-switcher/useWorkspaceActions'

/** Whether ⌘ is held with no other modifier but, when `shift` is true, ⇧. */
function isCommand(event: KeyboardEvent, shift: boolean): boolean {
  return event.metaKey && event.shiftKey === shift && !event.altKey && !event.ctrlKey
}

/** The digit of ⌘1 – ⌘9, or null for any other key. */
function switchDigit(event: KeyboardEvent): number | null {
  return isCommand(event, false) && /^[1-9]$/.test(event.key) ? Number(event.key) : null
}

/**
 * The workspace shortcuts, wherever the focus is: ⌘1 – ⌘9 switch to the nth workspace, oldest first (as the switcher
 * lists them); ⌘⇧N (New workspace…) and ⌘O (Open folder as workspace…) choose a folder and open it as a workspace.
 * Must be used under a `ToastProvider`.
 */
export function useWorkspaceShortcuts(): void {
  const workspaces = useGladeStore((state) => state.workspaces)
  const { add, open } = useWorkspaceActions()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const digit = switchDigit(event)
      if (digit !== null) {
        event.preventDefault()
        const workspace = workspaceAt(workspaces, digit)
        if (workspace !== undefined) open(workspace.id)
        return
      }
      const key = event.key.toLowerCase()
      if ((key === 'n' && isCommand(event, true)) || (key === 'o' && isCommand(event, false))) {
        event.preventDefault()
        add()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [workspaces, add, open])
}

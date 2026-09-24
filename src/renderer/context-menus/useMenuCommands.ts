import { useCallback } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** What a menu item runs that can fail: its failure shows as a toast. */
export type RunCommand = (command: () => Promise<unknown>) => void

export interface MenuCommands {
  /** Runs a command, showing a toast if it fails. */
  readonly run: RunCommand
  /** Puts text on the clipboard, showing a toast if it can't. */
  readonly copy: (text: string) => void
}

/** Runs the menus' commands, each failure shown as a toast. Must be used under a `ToastProvider`. */
export function useMenuCommands(): MenuCommands {
  const copyText = useGladeStore((state) => state.copyText)
  const toast = useToast()
  const run = useCallback<RunCommand>(
    (command) => {
      command().catch((error: unknown) => {
        toast.show({ message: describeFailure(error) })
      })
    },
    [toast],
  )
  const copy = useCallback(
    (text: string) => {
      run(() => copyText(text))
    },
    [run, copyText],
  )
  return { run, copy }
}

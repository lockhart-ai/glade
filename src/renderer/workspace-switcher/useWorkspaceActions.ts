import { useMemo } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** What the switcher and the workspace shortcuts do. Each shows a failure as a toast rather than rejecting. */
export interface WorkspaceActions {
  /** New workspace… (⌘⇧N) and Open folder as workspace… (⌘O): choose a folder, add it as a workspace and open it. */
  add: () => void
  /** Switches to a workspace, restoring its selection. Does nothing for the one already shown. */
  open: (workspaceId: string) => void
  /** Shows a workspace's root in Finder. */
  reveal: (workspaceId: string) => void
}

/** The workspace actions, for the switcher and its shortcuts. Must be used under a `ToastProvider`. */
export function useWorkspaceActions(): WorkspaceActions {
  const addWorkspace = useGladeStore((state) => state.addWorkspace)
  const openWorkspace = useGladeStore((state) => state.openWorkspace)
  const revealWorkspace = useGladeStore((state) => state.revealWorkspace)
  const shownId = useGladeStore((state) => state.selectedWorkspaceId)
  const toast = useToast()

  return useMemo(() => {
    const run = (action: Promise<unknown>): void => {
      action.catch((error: unknown) => {
        toast.show({ message: describeFailure(error) })
      })
    }
    return {
      add: () => {
        run(addWorkspace())
      },
      open: (workspaceId) => {
        if (workspaceId !== shownId) run(openWorkspace(workspaceId))
      },
      reveal: (workspaceId) => {
        run(revealWorkspace(workspaceId))
      },
    }
  }, [addWorkspace, openWorkspace, revealWorkspace, shownId, toast])
}

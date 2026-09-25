import { useMemo } from 'react'
import { UiStateKey } from '../../shared/domain'
import { parseRelaunchNotice } from '../../shared/relaunchNotice'
import { Button, ButtonSize, ButtonVariant, useOverlayRef } from '../components'
import { useGladeStore } from '../store/react'
import styles from './RelaunchNotice.module.css'

/** What the notice says about the tasks that picked up where they left off. */
export function relaunchMessage(count: number): string {
  const tasks =
    count === 1
      ? '1 task was mid-turn and has picked up where it left off.'
      : `${String(count)} tasks were mid-turn and have picked up where they left off.`
  return `Everything was saved. ${tasks}`
}

/**
 * The notice after Glade quit unexpectedly with tasks mid-turn (`docs/design/html/18-relaunch.html`), in the window's
 * top right corner until you dismiss it (`../../shared/relaunchNotice`). Show them opens the first of those tasks,
 * preferring one in the workspace you're looking at, and dismisses the notice. Tasks deleted since don't count; with
 * none left, there's no notice.
 */
export function RelaunchNotice(): React.JSX.Element | null {
  const value = useGladeStore((state) => state.uiState[UiStateKey.RelaunchNotice])
  const tasks = useGladeStore((state) => state.tasks)
  const selectedWorkspaceId = useGladeStore((state) => state.selectedWorkspaceId)
  const setUiState = useGladeStore((state) => state.setUiState)
  const selectTask = useGladeStore((state) => state.selectTask)
  const notice = useMemo(() => parseRelaunchNotice(value), [value])
  const overlay = useOverlayRef()

  const taskIds = notice?.taskIds.filter((id) => id in tasks) ?? []
  const [first] = taskIds
  if (first === undefined) return null

  const dismiss = (): Promise<void> => setUiState({ key: UiStateKey.RelaunchNotice, value: '' })
  const showThem = async (): Promise<void> => {
    const shown = taskIds.find((id) => tasks[id]?.workspaceId === selectedWorkspaceId) ?? first
    await dismiss()
    await selectTask(shown)
  }

  return (
    <div ref={overlay} role="status" aria-label="Glade quit unexpectedly" className={styles.notice}>
      <div className={styles.title}>Glade quit unexpectedly</div>
      <div className={styles.message}>{relaunchMessage(taskIds.length)}</div>
      <div className={styles.actions}>
        <Button variant={ButtonVariant.Dark} size={ButtonSize.Small} onClick={() => void showThem()}>
          Show them
        </Button>
        <Button variant={ButtonVariant.Ghost} size={ButtonSize.Small} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

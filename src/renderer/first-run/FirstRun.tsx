import { faFolder } from '@fortawesome/free-regular-svg-icons'
import { faPlus } from '@fortawesome/free-solid-svg-icons'
import gladeMark from '../../../assets/icon/glade-mark.svg'
import { Button, ButtonSize, ButtonVariant, Card, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import styles from './FirstRun.module.css'

/**
 * The task card's content before there is any workspace: a welcome with Open folder… and Create a new folder…. Both
 * use the native folder dialog (it has New Folder); choosing a folder adds it as a workspace and opens it. Failures,
 * such as a root that isn't a folder, show as a toast.
 */
export function FirstRun(): React.JSX.Element {
  const chooseFolder = useGladeStore((state) => state.chooseFolder)
  const createWorkspace = useGladeStore((state) => state.createWorkspace)
  const toast = useToast()

  const addWorkspace = async (): Promise<void> => {
    try {
      const path = await chooseFolder()
      if (path !== null) await createWorkspace(path)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }

  return (
    <Card role="main" aria-label="Welcome" className={styles.card}>
      <div className={styles.welcome}>
        <div className={styles.mark}>
          <img src={gladeMark} alt="" width={56} height={56} />
        </div>
        <h1 className={styles.title}>Welcome to Glade</h1>
        <p className={styles.lede}>A workspace is a folder you point Glade at. Every task runs inside it.</p>
        <div className={styles.actions}>
          <Button
            variant={ButtonVariant.Primary}
            size={ButtonSize.Large}
            icon={faFolder}
            onClick={() => void addWorkspace()}
          >
            Open folder…
          </Button>
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Large}
            icon={faPlus}
            onClick={() => void addWorkspace()}
          >
            Create a new folder…
          </Button>
        </div>
        <p className={styles.note}>Add more workspaces later from the Workspace menu.</p>
      </div>
    </Card>
  )
}

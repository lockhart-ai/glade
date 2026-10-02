import type { AttachedFile } from '../../shared/attachedFiles'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { MessageFileChip } from './FileChip'
import { opensInFiles } from './fileIcons'
import styles from './FileChip.module.css'

export interface MessageFilesProps {
  /** The task the message is in, whose workspace has the files. */
  readonly taskId: string
  /** The message's attached files, in order. */
  readonly files: readonly AttachedFile[]
}

/**
 * The files attached to your message in the chat, as chips above its words, where its images go
 * (`docs/design/html/36-attached-files.html`). Clicking one opens it in the Files tab when the tab shows its kind (text
 * or an image), or reveals it in Finder (a PDF, a spreadsheet). Nothing when there are none.
 */
export function MessageFiles({ taskId, files }: MessageFilesProps): React.JSX.Element | null {
  const showFile = useGladeStore((state) => state.showFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const toast = useToast()
  if (files.length === 0) return null

  const open = (file: AttachedFile): void => {
    const opening = opensInFiles(file) ? showFile(taskId, file.path) : revealFile(taskId, file.path)
    opening.catch((error: unknown) => {
      toast.show({ message: `Couldn’t open ${file.name}: ${describeFailure(error)}` })
    })
  }

  return (
    <ul className={styles.messageFiles} aria-label="Attached files">
      {files.map((file) => (
        <li key={file.path} className={styles.messageFile}>
          <MessageFileChip
            file={file}
            onOpen={() => {
              open(file)
            }}
          />
        </li>
      ))}
    </ul>
  )
}

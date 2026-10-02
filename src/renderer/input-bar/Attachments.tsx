import { faXmark } from '@fortawesome/free-solid-svg-icons'
import type { AttachedFile } from '../../shared/attachedFiles'
import { imageDataUrl, type ImageData } from '../../shared/images'
import { InputFileChip } from '../attached-files/FileChip'
import { Icon, IconSize } from '../components'
import { IMAGE_LABEL } from '../images/StoredImage'
import styles from './InputBar.module.css'

/** An image pasted into the message being written, not sent yet. */
export interface Attachment {
  /** Tells attachments apart, even the same image pasted twice. */
  readonly key: number
  readonly image: ImageData
}

export interface AttachmentsProps {
  readonly attachments: readonly Attachment[]
  /** The files attached to the message, already copied into the workspace (#396). */
  readonly files: readonly AttachedFile[]
  /** Why the last things pasted couldn't be attached (or sent), one line each. */
  readonly refusals: readonly string[]
  readonly onRemove: (key: number) => void
  /** Shows a file's copy in Finder. */
  readonly onRevealFile: (file: AttachedFile) => void
  /** Takes a file off the message. */
  readonly onRemoveFile: (file: AttachedFile) => void
}

/**
 * The images pasted into the message, as small thumbnails above its text, each with a remove button
 * (`docs/design/html/02-agent-working.html`), then the files attached to it, each a chip in the same row
 * (`docs/design/html/36-attached-files.html`), and why anything pasted wasn't attached. Nothing when there's none.
 */
export function Attachments({
  attachments,
  files,
  refusals,
  onRemove,
  onRevealFile,
  onRemoveFile,
}: AttachmentsProps): React.JSX.Element | null {
  if (attachments.length === 0 && files.length === 0 && refusals.length === 0) return null
  return (
    <div className={styles.attachments}>
      {(attachments.length > 0 || files.length > 0) && (
        <div className={styles.attached}>
          {attachments.length > 0 && (
            <ul className={styles.thumbnails} aria-label="Attached images">
              {attachments.map(({ key, image }, index) => (
                <li key={key} className={styles.thumbnail}>
                  <img src={imageDataUrl(image)} alt={`${IMAGE_LABEL} ${String(index + 1)}`} className={styles.image} />
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove image ${String(index + 1)}`}
                    title="Remove image"
                    onClick={() => {
                      onRemove(key)
                    }}
                  >
                    <Icon icon={faXmark} size={IconSize.Small} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 && (
            <ul className={styles.thumbnails} aria-label="Attached files">
              {files.map((file) => (
                <InputFileChip
                  key={file.path}
                  file={file}
                  onReveal={() => {
                    onRevealFile(file)
                  }}
                  onRemove={() => {
                    onRemoveFile(file)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {refusals.map((reason, index) => (
        <p key={`${String(index)} ${reason}`} role="alert" className={styles.refusal}>
          {reason}
        </p>
      ))}
    </div>
  )
}

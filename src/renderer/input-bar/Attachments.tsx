import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { imageDataUrl, type ImageData } from '../../shared/images'
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
  /** Why the last things pasted couldn't be attached (or sent), one line each. */
  readonly refusals: readonly string[]
  readonly onRemove: (key: number) => void
}

/**
 * The images pasted into the message, as small thumbnails above its text, each with a remove button
 * (`docs/design/html/02-agent-working.html`), and why anything pasted wasn't attached. Nothing when there's neither.
 */
export function Attachments({ attachments, refusals, onRemove }: AttachmentsProps): React.JSX.Element | null {
  if (attachments.length === 0 && refusals.length === 0) return null
  return (
    <div className={styles.attachments}>
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
      {refusals.map((reason, index) => (
        <p key={`${String(index)} ${reason}`} role="alert" className={styles.refusal}>
          {reason}
        </p>
      ))}
    </div>
  )
}

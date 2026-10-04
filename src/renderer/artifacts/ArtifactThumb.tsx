import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import styles from './ArtifactThumb.module.css'

export interface ArtifactThumbProps {
  /** Its thumbnail, as a data URL; null while there's none, which shows `icon` in the same frame. */
  readonly image: string | null
  /** The icon of what it is, in the thumbnail's place. */
  readonly icon: IconDefinition
  /** The thumbnail has loaded. */
  readonly onLoad?: (() => void) | undefined
  /** The window can't draw the thumbnail. */
  readonly onError?: (() => void) | undefined
  /** A class for the frame, either way. */
  readonly className?: string | undefined
  /** A class for the frame while it holds the icon. */
  readonly blankClassName?: string | undefined
}

/**
 * An artifact's thumbnail in its 40×28 frame, or the icon of what it is in the same frame: in a row of the Artifacts
 * tab, and where an image file's tile has its icon in the todo hub (P16, #498).
 */
export function ArtifactThumb({
  image,
  icon,
  onLoad,
  onError,
  className,
  blankClassName,
}: ArtifactThumbProps): React.JSX.Element {
  if (image === null) {
    return (
      <span className={classNames(styles.frame, className, blankClassName)}>
        <Icon icon={icon} size={IconSize.Medium} />
      </span>
    )
  }
  return (
    <span className={classNames(styles.frame, className)}>
      <img className={styles.image} src={image} alt="" draggable={false} onLoad={onLoad} onError={onError} />
    </span>
  )
}

import { faShield } from '@fortawesome/free-solid-svg-icons'
import { memo } from 'react'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { permissionDetail, permissionStatus, type PermissionLine } from './permissionLineModel'
import styles from './PermissionLine.module.css'

/**
 * The shield: the mark of the sandbox and of permissions, on the permission card's title and on every permission line.
 * It's always filled (`docs/design/README.md`); where it shows a state, its colour does.
 */
export const PERMISSION_SHIELD = faShield

/** What a screen reader calls the line's shield. */
export const PERMISSION_LINE_LABEL = 'Permission'

/** The attribute a permission line carries, holding its state (`PermissionLineState`). */
export const PERMISSION_LINE_STATE = 'data-permission'

export interface PermissionLineViewProps {
  readonly line: PermissionLine
  /** Where the line sits in its row: its indent and the space above it. */
  readonly className?: string | undefined
}

/**
 * A permission line (`./permissionLineModel`), as a tool call's row shows it: the filled shield in its state's colour,
 * the status in that colour too, then, after a colon, what it was about and a denial's note in the row's own grey. A
 * line that's its status alone has no colon; a withdrawn one is dimmed throughout. It wraps rather than cuts a long note
 * short. Phrasing content, so it can sit inside the row's button.
 */
export const PermissionLineView = memo(function PermissionLineView({
  line,
  className,
}: PermissionLineViewProps): React.JSX.Element {
  const detail = permissionDetail(line)
  return (
    <span
      className={classNames(styles.line, styles[line.state], className)}
      {...{ [PERMISSION_LINE_STATE]: line.state }}
    >
      <span role="img" aria-label={PERMISSION_LINE_LABEL} className={styles.shield}>
        <Icon icon={PERMISSION_SHIELD} size={IconSize.Small} />
      </span>
      <span className={styles.text}>
        <span className={styles.status}>
          {permissionStatus(line)}
          {detail !== null && ':'}
        </span>
        {detail !== null && ` ${detail}`}
      </span>
    </span>
  )
})

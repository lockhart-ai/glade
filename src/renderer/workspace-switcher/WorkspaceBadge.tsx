import { classNames } from '../components/classNames'
import { BadgeTone, workspaceInitial } from './switcherModel'
import styles from './WorkspaceBadge.module.css'

export enum BadgeSize {
  /** In the switcher's rows. */
  Medium = 'medium',
  /** In the sidebar header. */
  Large = 'large',
}

export interface WorkspaceBadgeProps {
  /** The workspace's name, whose initial the badge shows; undefined for no workspace, which shows ?. */
  name?: string
  tone: BadgeTone
  size?: BadgeSize
}

const TONE_CLASSES: Readonly<Record<BadgeTone, string | undefined>> = {
  [BadgeTone.Blue]: styles.blue,
  [BadgeTone.Purple]: styles.purple,
  [BadgeTone.Teal]: styles.teal,
  [BadgeTone.Pink]: styles.pink,
}

/** A workspace's initial in a rounded square of its colour. Decorative: the name is always shown beside it. */
export function WorkspaceBadge({ name, tone, size = BadgeSize.Medium }: WorkspaceBadgeProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={classNames(styles.badge, TONE_CLASSES[tone], size === BadgeSize.Large && styles.large)}
    >
      {name === undefined ? '?' : workspaceInitial(name)}
    </span>
  )
}

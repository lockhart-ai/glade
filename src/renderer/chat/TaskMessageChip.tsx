import { faRightLeft } from '@fortawesome/free-solid-svg-icons'
import { Icon, IconSize } from '../components'
import styles from './TaskMessageChip.module.css'

export interface TaskMessageChipProps {
  /** The sending task's title, or "Task" when it has none (`TaskMessage.senderTitle`). */
  readonly title: string
}

/**
 * Marks a message another task's agent sent (#710): the small ⇄ chip above the message naming the sending task,
 * in the task accent, and the same name again in the line under the message where "you" would be. A message from
 * another task is a task's business, not the user's words, so it never reads as yours.
 */
export function TaskMessageChip({ title }: TaskMessageChipProps): React.JSX.Element {
  return (
    <span className={styles.chip}>
      <Icon icon={faRightLeft} size={IconSize.Small} className={styles.icon} />
      <span className={styles.title}>{title}</span>
    </span>
  )
}

import { MessageSource } from '../../shared/domain'
import styles from './SourceTag.module.css'

/** What each source's tag says, by its style: small mono caps. */
export const SOURCE_TAG_LABELS: Readonly<Record<MessageSource, string>> = {
  [MessageSource.Broadcast]: 'Broadcast',
  [MessageSource.Github]: 'GitHub',
}

export interface SourceTagProps {
  readonly source: MessageSource
}

/**
 * Marks a message that isn't your own words (#489, #682): beside "you" and its time under your message in the chat,
 * and on its row while it waits in a task's queue. One sent to every active task at once with Broadcast says so;
 * one of Glade's own watchers (the GitHub link watcher) left its own tag, so neither reads as the owner's words. Grey:
 * it says where the message came from, not that anything needs you.
 */
export function SourceTag({ source }: SourceTagProps): React.JSX.Element {
  return <span className={styles.tag}>{SOURCE_TAG_LABELS[source]}</span>
}

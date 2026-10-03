import styles from './BroadcastTag.module.css'

/** What the tag says: small mono caps, by its style. */
export const BROADCAST_TAG = 'Broadcast'

/**
 * Marks a message you sent to every active task at once (Broadcast, #489; `docs/design/html/39-broadcast-message.html`):
 * beside "you" and its time under your message in the chat, and on its row while it waits in a task's queue. Grey: it
 * says where the message came from, not that anything needs you.
 */
export function BroadcastTag(): React.JSX.Element {
  return <span className={styles.tag}>{BROADCAST_TAG}</span>
}

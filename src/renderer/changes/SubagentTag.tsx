import { classNames } from '../components/classNames'
import styles from './SubagentTag.module.css'

export interface SubagentTagProps {
  /** The subagent's name. */
  readonly name: string
  /** What it did, in the tag's tooltip: `Made by the subagent “fix-501”`. */
  readonly title: string
  /** A class of the caller's own, e.g. for how the tag sits at the end of a tile's line in the todo hub. */
  readonly className?: string | undefined
  /** Shows the subagent: with it the tag is a button that goes there; without it, plain text. */
  readonly onOpen?: (() => void) | undefined
}

/**
 * The subagent that made something, as a tag after it: on a commit's tile in the Todos tab (P16), where it goes to the
 * subagent's tab in the Agents tab (#537).
 */
export function SubagentTag({ name, title, className, onOpen }: SubagentTagProps): React.JSX.Element {
  if (onOpen === undefined) {
    return (
      <span className={classNames(styles.subagent, className)} title={title}>
        {name}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={classNames(styles.subagent, styles.link, className)}
      title={title}
      onClick={(event) => {
        // The tag's own: not a click on whatever holds it (a tile, which it would close).
        event.stopPropagation()
        onOpen()
      }}
    >
      {name}
    </button>
  )
}

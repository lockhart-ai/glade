import { classNames } from '../components/classNames'
import styles from './SubagentTag.module.css'

export interface SubagentTagProps {
  /** The subagent's name. */
  readonly name: string
  /** What it did, in the tag's tooltip: `Made by the subagent “fix-501”`. */
  readonly title: string
  /** A class of the caller's own, e.g. for how the tag sits at the end of a tile's line in the todo hub. */
  readonly className?: string | undefined
}

/**
 * The subagent that made something, as a tag after it: a commit in the Changes tab, and in the todo hub (P16) a
 * commit's tile and the tile of a watcher a subagent left running.
 */
export function SubagentTag({ name, title, className }: SubagentTagProps): React.JSX.Element {
  return (
    <span className={classNames(styles.subagent, className)} title={title}>
      {name}
    </span>
  )
}

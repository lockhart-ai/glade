import type { ElementContent, Root, RootContent } from 'hast'
import { highlightParts } from '../../shared/search'

/** The text node's replacement: its parts, the matches wrapped in `<mark class=…>`. */
function marked(value: string, pattern: RegExp, className: string): ElementContent[] {
  return highlightParts(value, pattern).map((part) =>
    part.match
      ? {
          type: 'element',
          tagName: 'mark',
          properties: { className: [className] },
          children: [{ type: 'text', value: part.text }],
        }
      : { type: 'text', value: part.text },
  )
}

/** `children` with each text node's matches marked, all the way down. */
function highlight<Child extends RootContent>(
  children: readonly Child[],
  pattern: RegExp,
  className: string,
): (Child | ElementContent)[] {
  return children.flatMap((child): (Child | ElementContent)[] => {
    if (child.type === 'text') return marked(child.value, pattern, className)
    if (child.type === 'element') child.children = highlight(child.children, pattern, className)
    return [child]
  })
}

/**
 * A rehype plugin marking what `pattern` (from `highlightPattern`) matches in rendered Markdown's text, code included:
 * each match becomes a `<mark>` with `className`. It only splits text nodes, so a match that runs across formatting
 * (half of it bold) isn't marked. With no pattern it does nothing.
 */
export function rehypeHighlight(pattern: RegExp | null, className: string): () => (tree: Root) => void {
  return () => (tree) => {
    if (pattern !== null) tree.children = highlight(tree.children, pattern, className)
  }
}

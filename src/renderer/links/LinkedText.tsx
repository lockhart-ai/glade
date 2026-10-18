import { useMemo } from 'react'
import { Marked } from '../search/Highlight'
import { Link } from './Link'
import { linkedSegments, SegmentKind, type LinkedSegment } from './linkify'
import { TodoLink } from './TodoLink'

export interface LinkedTextProps {
  /** Plain text: nothing in it is Markdown. */
  readonly text: string
  /** What to mark, from `highlightPattern` (the sidebar's search); null or left out marks nothing. */
  readonly pattern?: RegExp | null | undefined
}

function SegmentView({ segment }: { readonly segment: LinkedSegment }): React.JSX.Element {
  switch (segment.kind) {
    case SegmentKind.Text:
      return <Marked parts={segment.parts} />
    case SegmentKind.Link:
      return (
        <Link href={segment.href} text={segment.text}>
          <Marked parts={segment.parts} />
        </Link>
      )
    case SegmentKind.Todo:
      return (
        <TodoLink href={`todo:${segment.todoId}`}>
          <Marked parts={segment.parts} />
        </TodoLink>
      )
  }
}

/**
 * Plain text with its bare URLs and email addresses as links (`Link`), which open in your browser, a `todo:` link
 * (`[any text](todo:N)`) as a link to that todo (`TodoLink`), and what the sidebar's search matches marked, in the
 * links too.
 */
export function LinkedText({ text, pattern = null }: LinkedTextProps): React.JSX.Element {
  const segments = useMemo(() => linkedSegments(text, pattern), [text, pattern])
  return (
    <>
      {segments.map((segment, index) => (
        <SegmentView key={index} segment={segment} />
      ))}
    </>
  )
}

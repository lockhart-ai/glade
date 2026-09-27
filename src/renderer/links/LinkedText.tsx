import { useMemo } from 'react'
import { Marked } from '../search/Highlight'
import { Link } from './Link'
import { linkedSegments, SegmentKind, type LinkedSegment } from './linkify'

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
  }
}

/**
 * Plain text with its bare URLs and email addresses as links (`Link`), which open in your browser, and what the
 * sidebar's search matches marked, in the links too.
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

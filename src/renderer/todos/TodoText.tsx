import { useMemo } from 'react'
import { Link, SegmentKind, type Segment } from '../links'
import { todoSegments, type LinkReferences } from './todoLinks'

export interface TodoTextProps {
  /** A todo's title or its status line: plain text, nothing in it is Markdown. */
  readonly text: string
  /** The PRs, issues and tickets the todo names, of those its task has as links (`namedBy`). */
  readonly links: LinkReferences
}

function SegmentView({ segment }: { readonly segment: Segment }): React.ReactNode {
  switch (segment.kind) {
    case SegmentKind.Text:
      return segment.text
    case SegmentKind.Link:
      return (
        <Link href={segment.href} text={segment.text}>
          {segment.text}
        </Link>
      )
  }
}

/**
 * A todo's title or status line in the hub (P16, #500): its bare URLs and email addresses as links, as in any plain
 * text (`LinkedText`), and the PRs, issues and tickets it names as links to the task's own link artifacts
 * (`todoSegments`). Each is the app's link (`Link`): it opens in the browser, shows its address as a tooltip, takes the
 * focus with Tab and has the link menu. The text is only read again when it, or what it names, changed.
 */
export function TodoText({ text, links }: TodoTextProps): React.JSX.Element {
  const segments = useMemo(() => todoSegments(text, links), [text, links])
  return (
    <>
      {segments.map((segment, index) => (
        <SegmentView key={index} segment={segment} />
      ))}
    </>
  )
}

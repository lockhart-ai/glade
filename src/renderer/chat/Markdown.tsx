import { useMemo, type Ref } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { classNames } from '../components/classNames'
import highlightStyles from '../search/Highlight.module.css'
import { rehypeHighlight } from '../search/rehypeHighlight'
import styles from './Markdown.module.css'

export interface MarkdownProps {
  /** The Markdown source. */
  source: string
  className?: string
  /** What to mark in the rendered text (the sidebar's search, from `highlightPattern`); nothing when left out. */
  highlight?: RegExp | null
  ref?: Ref<HTMLDivElement>
}

/**
 * Nothing in a message loads or opens anything: the renderer shows no remote content. A link shows as its text (the
 * address isn't followed), and an image as its alt text (it's never fetched).
 */
const COMPONENTS: Components = {
  a: ({ children }) => <span className={styles.link}>{children}</span>,
  img: ({ alt }) => <span className={styles.image}>{alt}</span>,
}

/** No URL survives into the rendered page, whatever element it would have ended up on. */
function dropUrl(): null {
  return null
}

/**
 * The elements inline Markdown keeps: code and emphasis, and the paragraphs and images it turns into plain text. Any
 * other element is unwrapped to its contents.
 */
const INLINE_ELEMENTS = ['p', 'img', 'code', 'em', 'strong']

/** A paragraph of inline Markdown is just its text, so paragraphs run on a space apart; an image is its alt text. */
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <>{children} </>,
  img: ({ alt }) => <>{alt}</>,
}

export interface InlineMarkdownProps {
  /** The Markdown source. */
  source: string
}

/**
 * A line of Markdown shown inline, like a tool log note: only code and emphasis come through. Anything else (a link,
 * an image, a heading, a list) shows as its text, a code block as inline code, and raw HTML is dropped.
 */
export function InlineMarkdown({ source }: InlineMarkdownProps): React.JSX.Element {
  return (
    <ReactMarkdown
      allowedElements={INLINE_ELEMENTS}
      unwrapDisallowed
      components={INLINE_COMPONENTS}
      skipHtml
      urlTransform={dropUrl}
    >
      {source}
    </ReactMarkdown>
  )
}

/** Chat Markdown (CommonMark and GitHub's tables, task lists and strikethrough), with code styled. Raw HTML is dropped. */
export function Markdown({ source, className, ref, highlight = null }: MarkdownProps): React.JSX.Element {
  const rehypePlugins = useMemo(() => [rehypeHighlight(highlight, highlightStyles.mark ?? '')], [highlight])
  return (
    <div ref={ref} className={classNames(styles.markdown, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
        skipHtml
        urlTransform={dropUrl}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

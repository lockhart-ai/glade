import type { Element } from 'hast'
import { useMemo, type Ref } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openableUrl } from '../../shared/links'
import { classNames } from '../components/classNames'
import { hastText, Link, remarkAutolinkLiterals } from '../links'
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
 * The renderer shows no remote content: nothing in a message loads anything. A link, written as one or as a bare URL or
 * email address (GFM's autolinks), opens in your browser when you click it, through main (`Link`); the window never
 * follows it. Only a web or mail link is a link: any other (a relative path, `file:`, `javascript:`) shows as its text.
 * An image shows as its alt text: it's never fetched. Code spans and blocks stay plain text, URLs and all.
 */
const COMPONENTS: Components = {
  a: ({ href, node, children }) =>
    href === undefined ? (
      <>{children}</>
    ) : (
      <Link href={href} text={node === undefined ? '' : hastText(node)}>
        {children}
      </Link>
    ),
  img: ({ alt }) => <span className={styles.image}>{alt}</span>,
}

/** The only URL that survives into the rendered page: a link's, when it's one Glade opens (`openableUrl`). */
function linkUrl(url: string, key: string, node: Readonly<Element>): string | null {
  return node.tagName === 'a' && key === 'href' ? openableUrl(url) : null
}

/**
 * The elements inline Markdown keeps: code, emphasis and links, and the paragraphs and images it turns into plain text.
 * Any other element is unwrapped to its contents.
 */
const INLINE_ELEMENTS = ['p', 'img', 'code', 'em', 'strong', 'a']

/** A paragraph of inline Markdown is just its text, so paragraphs run on a space apart; an image is its alt text. */
const INLINE_COMPONENTS: Components = {
  a: COMPONENTS.a,
  p: ({ children }) => <>{children} </>,
  img: ({ alt }) => <>{alt}</>,
}

export interface InlineMarkdownProps {
  /** The Markdown source. */
  source: string
}

/**
 * A line of Markdown shown inline, like a tool log note: only code, emphasis and links come through, and a bare URL is
 * a link, as in a reply. Anything else (an image, a heading, a list) shows as its text, a code block as inline code,
 * and raw HTML is dropped.
 */
export function InlineMarkdown({ source }: InlineMarkdownProps): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkAutolinkLiterals]}
      allowedElements={INLINE_ELEMENTS}
      unwrapDisallowed
      components={INLINE_COMPONENTS}
      skipHtml
      urlTransform={linkUrl}
    >
      {source}
    </ReactMarkdown>
  )
}

/**
 * Chat Markdown (CommonMark and GitHub's tables, task lists, strikethrough and autolinks), with code styled. Raw HTML
 * is dropped.
 */
export function Markdown({ source, className, ref, highlight = null }: MarkdownProps): React.JSX.Element {
  const rehypePlugins = useMemo(() => [rehypeHighlight(highlight, highlightStyles.mark ?? '')], [highlight])
  return (
    <div ref={ref} className={classNames(styles.markdown, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
        skipHtml
        urlTransform={linkUrl}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

import type { Element } from 'hast'
import { createContext, useContext, useMemo, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openableUrl } from '../../shared/links'
import { classNames } from '../components/classNames'
import { CopiedTag, CopyBlockButton, useCopyFeedback } from '../components/CodeCopy/CodeCopy'
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
  /**
   * Whether code spans and blocks click to copy (#352). On by everywhere Glade shows Markdown but the Files viewer's
   * preview, which turns it off: it isn't a chat surface, and the copy icons don't reach it.
   */
  interactiveCode?: boolean
  ref?: Ref<HTMLDivElement>
}

/**
 * Whether the nearest code span is inside a fenced block (`CodeBlock`), which copies as a whole from its own icon:
 * then the span itself renders plain, rather than each one in it copying on its own.
 */
const InCodeBlock = createContext(false)

interface CodeSpanProps {
  readonly children?: ReactNode
  readonly className?: string
}

/**
 * An inline code span (#352): a plain click copies its exact text, with "Copied" shown for a moment. Dragging a
 * selection in it, or a click that ends with a non-empty selection, is left as ordinary text selection instead.
 * Focusable, and Enter or Space copies it too. Nested in a fenced code block (`InCodeBlock`), it's plain instead.
 */
function CodeSpan({ children, className }: CodeSpanProps): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const inBlock = useContext(InCodeBlock)
  const { copied, copy } = useCopyFeedback()

  if (inBlock) return <code className={className}>{children}</code>

  const copyItsText = (): void => {
    copy(ref.current?.textContent ?? '')
  }

  return (
    <code
      ref={ref}
      role="button"
      tabIndex={0}
      className={classNames(className, styles.codeSpan)}
      onClick={() => {
        const selection = window.getSelection()
        // A drag selection, or a click that ends with one in the span, is left as ordinary text selection.
        if (selection !== null && selection.toString() !== '') return
        copyItsText()
      }}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        copyItsText()
      }}
    >
      {children}
      {copied && <CopiedTag placement="beside" />}
    </code>
  )
}

interface CodeBlockProps {
  readonly children?: ReactNode
}

/** A fenced code block (#352): a copy icon in its corner, shown on hover and on focus, copies the whole block. */
function CodeBlock({ children }: CodeBlockProps): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className={styles.codeBlock}>
      <pre ref={ref}>
        <InCodeBlock.Provider value={true}>{children}</InCodeBlock.Provider>
      </pre>
      <CopyBlockButton getText={() => ref.current?.textContent ?? ''} className={styles.codeBlockCopy} />
    </div>
  )
}

/**
 * The renderer shows no remote content: nothing in a message loads anything. A link, written as one or as a bare URL or
 * email address (GFM's autolinks), opens in your browser when you click it, through main (`Link`); the window never
 * follows it. Only a web or mail link is a link: any other (a relative path, `file:`, `javascript:`) shows as its text.
 * An image shows as its alt text: it's never fetched. Code spans and blocks stay plain text, URLs and all, but click
 * (or their copy icon) to copy (#352).
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
  code: ({ className, children }) => <CodeSpan className={className}>{children}</CodeSpan>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
}

/**
 * Without code's click-to-copy (the Files viewer's preview, which the copy icons don't reach): the same components,
 * but code and fenced blocks render plain, as any other Markdown element not given its own component does.
 */
const PLAIN_CODE_COMPONENTS: Components = { a: COMPONENTS.a, img: COMPONENTS.img }

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
  code: COMPONENTS.code,
  p: ({ children }) => <>{children} </>,
  img: ({ alt }) => <>{alt}</>,
}

export interface InlineMarkdownProps {
  /** The Markdown source. */
  source: string
}

/**
 * A line of Markdown shown inline, like a tool log note: only code, emphasis and links come through, and a bare URL is
 * a link, as in a reply. Anything else (an image, a heading, a list) shows as its text, a code block as inline code
 * (click to copy, as in a reply), and raw HTML is dropped.
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
 * Chat Markdown (CommonMark and GitHub's tables, task lists, strikethrough and autolinks), with code styled: a span
 * clicks to copy, and a block has a copy icon in its corner (#352). Raw HTML is dropped.
 */
export function Markdown({
  source,
  className,
  ref,
  highlight = null,
  interactiveCode = true,
}: MarkdownProps): React.JSX.Element {
  const rehypePlugins = useMemo(() => [rehypeHighlight(highlight, highlightStyles.mark ?? '')], [highlight])
  return (
    <div ref={ref} className={classNames(styles.markdown, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={interactiveCode ? COMPONENTS : PLAIN_CODE_COMPONENTS}
        skipHtml
        urlTransform={linkUrl}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { classNames } from '../components/classNames'
import styles from './Markdown.module.css'

export interface MarkdownProps {
  /** The Markdown source. */
  source: string
  className?: string
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

/** Chat Markdown (CommonMark and GitHub's tables, task lists and strikethrough), with code styled. Raw HTML is dropped. */
export function Markdown({ source, className }: MarkdownProps): React.JSX.Element {
  return (
    <div className={classNames(styles.markdown, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml urlTransform={dropUrl}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

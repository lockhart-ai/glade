import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
import { FileContentKind, type FileContent } from '../../shared/domain'
import { isBridgeError } from '../../shared/bridge'
import { Markdown } from '../chat/Markdown'
import { clockTime } from '../chat/chatModel'
import { Button, ButtonSize, ButtonVariant, Segmented, type SegmentedOption } from '../components'
import { useGladeStore } from '../store/react'
import { FileTouch, formatSize, isMarkdown, type TouchedFile } from './filesModel'
import { highlight, languageOf, sourceLines } from './highlight'
import { BLOCK_LINES, SourceView, type HighlightedBlocks } from './SourceView'
import styles from './FileViewer.module.css'

/** How a Markdown file shows: its source, or rendered. */
export enum MarkdownMode {
  Source = 'source',
  Preview = 'preview',
}

const MODES: readonly SegmentedOption<MarkdownMode>[] = [
  { value: MarkdownMode.Source, label: 'Source' },
  { value: MarkdownMode.Preview, label: 'Preview' },
]

/** How the agent last touched the file, and when. */
export interface FileTouchInfo {
  readonly touch: FileTouch
  readonly file: TouchedFile
}

export interface FileViewerProps {
  taskId: string
  /** Relative to the workspace root. */
  path: string
  /** How the agent last touched the file; undefined when it hasn't (e.g. it only showed it). Its change re-reads it. */
  touched: FileTouchInfo | undefined
  /** A line to mark and scroll to (the agent's `show_file`), from 1; null for none. */
  focusLine: number | null
  /** Changes with every request to show `focusLine`. */
  focusRequest: number
}

/** The tokens highlighting has worked out so far, and the lines they're for. */
interface Colored {
  readonly lines: readonly string[]
  readonly blocks: HighlightedBlocks
}

const NO_BLOCKS: HighlightedBlocks = []

/** What reading the file has come to. */
type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'loaded'; readonly content: FileContent }
  | { readonly state: 'failed'; readonly message: string }

/** "Edited by the agent · 11:22". */
function touchLine({ touch, file }: FileTouchInfo): string {
  return `${touch === FileTouch.Changed ? 'Edited' : 'Read'} by the agent · ${clockTime(file.at)}`
}

/** The whole-file notice for a file the viewer can't show as text, or couldn't read. */
function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className={styles.notice} role="status">
      {children}
    </p>
  )
}

/**
 * A file of the task's workspace, read-only: its path, how the agent last touched it, and Open in editor over its
 * source, with line numbers and syntax highlighting. A Markdown file can show a preview instead. A file too large to
 * show whole shows its first lines, with a notice; a binary or missing one, a notice only. It's read again when the
 * agent touches it.
 */
export function FileViewer({ taskId, path, touched, focusLine, focusRequest }: FileViewerProps): React.JSX.Element {
  const readFile = useGladeStore((state) => state.readFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [mode, setMode] = useState(MarkdownMode.Source)
  const [colored, setColored] = useState<Colored>({ lines: [], blocks: [] })
  const version = touched?.file.eventId

  useEffect(() => {
    let current = true
    readFile(taskId, path).then(
      (content) => {
        if (current) setLoaded({ state: 'loaded', content })
      },
      (error: unknown) => {
        if (current) setLoaded({ state: 'failed', message: isBridgeError(error) ? error.message : String(error) })
      },
    )
    return () => {
      current = false
    }
  }, [readFile, taskId, path, version])

  const text = loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Text ? loaded.content.text : null
  const lines = useMemo(() => (text === null ? [] : sourceLines(text)), [text])
  const language = languageOf(path)

  useEffect(() => {
    if (language === null || lines.length === 0) return
    const controller = new AbortController()
    void highlight(
      lines,
      language,
      (start, tokens) => {
        setColored((previous) => {
          const blocks = previous.lines === lines ? [...previous.blocks] : []
          blocks[start / BLOCK_LINES] = tokens
          return { lines, blocks }
        })
      },
      controller.signal,
    )
    return () => {
      controller.abort()
    }
  }, [lines, language])
  // Tokens for other lines (the file before it changed) would colour the wrong text: show plain text till they come.
  const highlighted = colored.lines === lines ? colored.blocks : NO_BLOCKS

  const markdown = isMarkdown(path)
  const preview = markdown && mode === MarkdownMode.Preview

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <span className={styles.path}>{path}</span>
        {touched !== undefined && <span className={styles.touched}>{touchLine(touched)}</span>}
        <span className={styles.spacer} />
        {markdown && (
          <Segmented label="Show as" options={MODES} value={mode} onChange={setMode} className={styles.mode} />
        )}
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          icon={faArrowUpRightFromSquare}
          aria-keyshortcuts="Meta+Shift+E"
          title="Open in editor (⌘⇧E)"
          onClick={() => void openInEditor(taskId, path)}
        >
          Open in editor
        </Button>
      </div>
      {/* Focusable, so it can be scrolled with the keyboard, and ⌘W closes the file while it has the focus. */}
      <div className={styles.body} tabIndex={0} aria-label={`${path} contents`} role="region">
        {loaded.state === 'failed' && <Notice>This file can’t be shown: {loaded.message}</Notice>}
        {loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Missing && (
          <Notice>This file isn’t there any more.</Notice>
        )}
        {loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Binary && (
          <Notice>
            This file isn’t text ({formatSize(loaded.content.size)}), so it can’t be shown here. Open it in your editor
            instead.
          </Notice>
        )}
        {loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Text && (
          <>
            {loaded.content.truncated && (
              <p className={styles.truncated} role="note">
                This file is large ({formatSize(loaded.content.size)}), so only its first{' '}
                {lines.length.toLocaleString()} lines are shown. Open it in your editor to see it all.
              </p>
            )}
            {preview ? (
              <Markdown source={loaded.content.text} className={styles.preview} />
            ) : (
              <SourceView lines={lines} highlighted={highlighted} focusLine={focusLine} focusRequest={focusRequest} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

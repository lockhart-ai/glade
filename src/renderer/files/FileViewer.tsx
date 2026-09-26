import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
import { FileContentKind, type FileContent } from '../../shared/domain'
import { isBridgeError } from '../../shared/bridge'
import { Markdown } from '../chat/Markdown'
import { clockTime } from '../chat/chatModel'
import { Button, ButtonSize, ButtonVariant, Segmented, type SegmentedOption } from '../components'
import { useGladeStore } from '../store/react'
import { WindowCommandId } from '../../shared/commands'
import { useBinding } from '../commands/hooks'
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

/** A file as one of the task's commits left it: where it is in the commit's repository, and which commit. */
export interface FileVersion {
  /** Relative to the top of the commit's repository. */
  readonly path: string
  /** The commit's short hash; null when the task no longer has the commit. */
  readonly hash: string | null
}

export interface FileViewerProps {
  taskId: string
  /** Relative to the workspace root; or, for a file as a commit left it, its commit file key (`commitFileKey`). */
  path: string
  /**
   * For a file as a commit left it: its path, and the commit. It shows read-only, labelled with the commit's hash, with
   * no Open in editor, since it's only in git. Null (the default) for a file in the workspace.
   */
  fromCommit?: FileVersion | null
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
export function FileViewer({
  taskId,
  path,
  fromCommit = null,
  touched,
  focusLine,
  focusRequest,
}: FileViewerProps): React.JSX.Element {
  const readFile = useGladeStore((state) => state.readFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const openInEditorKeys = useBinding(WindowCommandId.OpenInEditor)
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
  // A file as a commit left it is named by its path in the commit.
  const shownPath = fromCommit?.path ?? path
  const language = languageOf(shownPath)

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

  const markdown = isMarkdown(shownPath)
  const preview = markdown && mode === MarkdownMode.Preview

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <span className={styles.path}>{shownPath}</span>
        {touched !== undefined && <span className={styles.touched}>{touchLine(touched)}</span>}
        {fromCommit !== null && (
          <span className={styles.touched}>
            {fromCommit.hash === null ? 'As a commit left it' : `As of ${fromCommit.hash}`} · read-only
          </span>
        )}
        <span className={styles.spacer} />
        {markdown && (
          <Segmented label="Show as" options={MODES} value={mode} onChange={setMode} className={styles.mode} />
        )}
        {fromCommit === null && (
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Small}
            icon={faArrowUpRightFromSquare}
            aria-keyshortcuts={openInEditorKeys.ariaKeyShortcuts}
            title={`Open in editor (${openInEditorKeys.label})`}
            onClick={() => void openInEditor(taskId, path)}
          >
            Open in editor
          </Button>
        )}
      </div>
      {/* Focusable, so it can be scrolled with the keyboard, and ⌘W closes the file while it has the focus. */}
      <div className={styles.body} tabIndex={0} aria-label={`${shownPath} contents`} role="region">
        {loaded.state === 'failed' && <Notice>This file can’t be shown: {loaded.message}</Notice>}
        {loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Missing && (
          <Notice>
            {fromCommit === null ? 'This file isn’t there any more.' : 'This commit’s file can’t be read any more.'}
          </Notice>
        )}
        {loaded.state === 'loaded' && loaded.content.kind === FileContentKind.Binary && (
          <Notice>
            {fromCommit === null
              ? `This file isn’t text (${formatSize(loaded.content.size)}), so it can’t be shown here. Open it in your editor instead.`
              : `This file isn’t text (${formatSize(loaded.content.size)}), so it can’t be shown here.`}
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

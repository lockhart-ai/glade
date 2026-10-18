import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileContentKind, type FileContent, type ImageFileContent } from '../../shared/domain'
import { isBridgeError } from '../../shared/bridge'
import { Markdown } from '../chat/Markdown'
import { clockTime } from '../chat/chatModel'
import { Button, ButtonSize, ButtonVariant, Segmented, type SegmentedOption } from '../components'
import { naturalSizeOf, useImageZoom } from '../images/useImageZoom'
import type { Size } from '../images/zoomModel'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { WindowCommandId } from '../../shared/commands'
import { useBinding } from '../commands/hooks'
import { FileSession, isEditable } from './fileSession'
import { FileTouch, formatSize, isHtml, isMarkdown, sameFileContent, type TouchedFile } from './filesModel'
import { highlight, languageOf, sourceLines, type Language } from './highlight'
import { HtmlPreview } from './HtmlPreview'
import { SourceEditor } from './SourceEditor'
import { BLOCK_LINES, SourceView, type HighlightedBlocks } from './SourceView'
import type { OpenEditSession } from './unsaved'
import styles from './FileViewer.module.css'

/** The file's name, the last part of its path: what an image open in the Files tab is called in its zoom and alt text. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

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
const NO_LINES: readonly string[] = []

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

/** What makes a file's editor: its text as read, highlighted in its language, named for its path. */
function editorFor(text: string, language: Language | null, path: string): OpenEditSession {
  return (onEditState) => new FileSession({ text, language, label: `${path} contents` }, onEditState)
}

interface ImageFileViewProps {
  readonly content: ImageFileContent
  /** The file's name, for its alt text and the zoom's label. */
  readonly name: string
}

/**
 * An image file, fit to the panel but never scaled past its own size, on a checkerboard behind transparency. It zooms
 * in place (#685), by `useImageZoom`: the trackpad's pinch zooms around the pointer, ⌘+ and ⌘− zoom, ⌘0 returns to
 * fit, a click (or ↵ or Space, focused) toggles fit and actual size at the clicked spot, and zoomed in, a drag or a
 * scroll pans. Another image file showing starts at its own fit.
 */
function ImageFileView({ content, name }: ImageFileViewProps): React.JSX.Element {
  const [natural, setNatural] = useState<Size | null>(null)
  const onNatural = useCallback((size: Size | null): void => {
    setNatural((previous) =>
      previous === size ||
      (previous !== null && size !== null && previous.width === size.width && previous.height === size.height)
        ? previous
        : size,
    )
  }, [])
  const { viewRef, frameRef, frameStyle, zoomed } = useImageZoom({ natural, imageKey: content.dataUrl })
  return (
    <div className={styles.imageBody}>
      <div
        ref={viewRef}
        className={styles.imageZoom}
        tabIndex={0}
        role="button"
        aria-label={`Zoom ${name}`}
        title={`Zoom ${name}`}
        data-zoomed={zoomed ? '' : undefined}
      >
        <img
          ref={frameRef}
          src={content.dataUrl}
          alt={name}
          className={styles.image}
          style={frameStyle}
          onLoad={(event) => {
            onNatural(naturalSizeOf(event.currentTarget))
          }}
          onError={() => {
            onNatural(null)
          }}
        />
      </div>
    </div>
  )
}

/**
 * A file of the task's workspace: its path, how the agent last touched it, and Open in editor over its source. A file
 * shown whole is edited in place (`SourceEditor`), looking just as the read-only source does; its edits stay while
 * other tabs show, until you save them (⌘S) or discard them. A Markdown file, and a workspace's static HTML file,
 * open on their preview, with the source beside it (`Source`); a line the agent shows brings the source back to mark
 * it. A file as a commit left it, or one too large to show whole, shows read-only (`SourceView`), the latter its
 * first lines, with a notice; a binary or missing one, a notice only. It's read again when the agent touches it, or
 * the watch on the open file says it changed on disk (#646): an editor with no unsaved edits takes the new text
 * quietly, and one with unsaved edits shows a bar to Reload or Keep mine. The HTML preview reloads when a read finds
 * the file different from the read before it, so the same text again leaves it be.
 */
export function FileViewer({
  taskId,
  path,
  fromCommit = null,
  touched,
  focusLine,
  focusRequest,
}: FileViewerProps): React.JSX.Element {
  const store = useGladeStoreApi()
  const readFile = useGladeStore((state) => state.readFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const startEditing = useGladeStore((state) => state.startEditing)
  const reloadFile = useGladeStore((state) => state.reloadFile)
  const keepMyEdits = useGladeStore((state) => state.keepMyEdits)
  // A file as a commit left it is only ever read.
  const inWorkspace = fromCommit === null
  const edit = useGladeStore((state) => (inWorkspace ? state.fileEdits[taskId]?.[path] : undefined))
  const openInEditorKeys = useBinding(WindowCommandId.OpenInEditor)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  // A file with a preview opens on it; one the agent is showing at a line starts on the source, so the line can show.
  const [mode, setMode] = useState(focusLine === null ? MarkdownMode.Preview : MarkdownMode.Source)
  const [colored, setColored] = useState<Colored>({ lines: [], blocks: [] })
  const touchedVersion = touched?.file.eventId
  // How many times the watch on the open file has seen it change on disk (`files.fileChanged`): each one reads it
  // again, as the agent's touch does. A file as a commit left it is never watched, so never changes this way.
  const diskVersion = useGladeStore((state) => state.fileVersions[taskId]?.[path])
  // How many reads have found the file different from the read before: what the HTML preview reloads by. The same
  // text again (an agent's Read, a rewrite of the same bytes) doesn't count, so it changes nothing visible.
  const [previewVersion, setPreviewVersion] = useState(0)
  const lastLoaded = useRef<FileContent | null>(null)
  // A file as a commit left it is named by its path in the commit.
  const shownPath = fromCommit?.path ?? path
  const language = languageOf(shownPath)
  const session = edit?.session

  // A line the agent shows is marked in the source, so each request for one switches back to it. Done while rendering
  // (React's pattern for adjusting state when a prop changes): while the file shows the viewer is already mounted, and
  // `focusRequest` goes up with every request, so this fires again for each.
  const [revealed, setRevealed] = useState(focusRequest)
  if (focusRequest !== revealed) {
    setRevealed(focusRequest)
    if (focusLine !== null) setMode(MarkdownMode.Source)
  }

  useEffect(() => {
    let current = true
    readFile(taskId, path).then(
      (content) => {
        if (!current) return
        // The file's editor takes what's on disk now; a workspace file shown whole, with none yet, gets one.
        if (inWorkspace) {
          const file = { taskId, path }
          const opened = store.getState().fileEdits[taskId]?.[path]
          if (opened === undefined) {
            if (isEditable(content)) startEditing(file, editorFor(content.text, language, path))
          } else if (!opened.session.receive(content)) {
            store.getState().stopEditing(file)
          }
        }
        const changed = lastLoaded.current !== null && !sameFileContent(lastLoaded.current, content)
        lastLoaded.current = content
        if (changed) setPreviewVersion((bumps) => bumps + 1)
        setLoaded({ state: 'loaded', content })
      },
      (error: unknown) => {
        if (current) setLoaded({ state: 'failed', message: isBridgeError(error) ? error.message : String(error) })
      },
    )
    return () => {
      current = false
    }
  }, [readFile, startEditing, store, inWorkspace, language, taskId, path, touchedVersion, diskVersion])

  const lastRead = loaded.state === 'loaded' ? loaded.content : null

  // Edits discarded (the prompt's Discard): the editor starts again from the file as last read.
  const reopenText =
    inWorkspace && session === undefined && lastRead !== null && isEditable(lastRead) ? lastRead.text : null
  useEffect(() => {
    if (reopenText !== null) startEditing({ taskId, path }, editorFor(reopenText, language, path))
  }, [reopenText, startEditing, language, taskId, path])

  // Only the read-only source is highlighted here: the editor highlights its own text.
  const readOnlyText =
    session === undefined && lastRead?.kind === FileContentKind.Text && !(inWorkspace && isEditable(lastRead))
      ? lastRead.text
      : null
  const lines = useMemo(() => (readOnlyText === null ? NO_LINES : sourceLines(readOnlyText)), [readOnlyText])

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
  // A file as a commit left it has no real folder on disk to serve the preview's assets from relative to that
  // commit: HTML preview is only for a workspace file, as Open in editor is.
  const html = inWorkspace && isHtml(shownPath)
  const preview = (markdown || html) && mode === MarkdownMode.Preview
  const editing = session !== undefined && !preview

  const previewOf = (text: string): React.ReactNode =>
    markdown ? (
      <div className={styles.preview}>
        <Markdown source={text} className={styles.previewColumn} interactiveCode={false} />
      </div>
    ) : (
      <HtmlPreview taskId={taskId} path={path} version={previewVersion} />
    )

  const body = (): React.ReactNode => {
    if (session !== undefined) {
      return preview ? (
        previewOf(session.text())
      ) : (
        <SourceEditor session={session} focusLine={focusLine} focusRequest={focusRequest} />
      )
    }
    if (loaded.state === 'loading') return null
    if (loaded.state === 'failed') return <Notice>This file can’t be shown: {loaded.message}</Notice>
    const { content } = loaded
    switch (content.kind) {
      case FileContentKind.Missing:
        return (
          <Notice>
            {inWorkspace ? 'This file isn’t there any more.' : 'This commit’s file can’t be read any more.'}
          </Notice>
        )
      case FileContentKind.Binary:
        return (
          <Notice>
            {inWorkspace
              ? `This file isn’t text (${formatSize(content.size)}), so it can’t be shown here. Open it in your editor instead.`
              : `This file isn’t text (${formatSize(content.size)}), so it can’t be shown here.`}
          </Notice>
        )
      case FileContentKind.Image:
        return <ImageFileView content={content} name={fileName(shownPath)} />
      case FileContentKind.Text:
        return (
          <>
            {content.truncated && (
              <p className={styles.truncated} role="note">
                This file is large ({formatSize(content.size)}), so only its first {lines.length.toLocaleString()} lines
                are shown. Open it in your editor to see it all.
              </p>
            )}
            {preview ? (
              previewOf(content.text)
            ) : (
              <SourceView lines={lines} highlighted={highlighted} focusLine={focusLine} focusRequest={focusRequest} />
            )}
          </>
        )
    }
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <span className={styles.path} title={shownPath}>
          <bdi dir="ltr">{shownPath}</bdi>
        </span>
        {touched !== undefined && <span className={styles.touched}>{touchLine(touched)}</span>}
        {fromCommit !== null && (
          <span className={styles.version}>
            {fromCommit.hash === null ? 'As a commit left it' : `As of ${fromCommit.hash}`} · read-only
          </span>
        )}
        <span className={styles.spacer} />
        {(markdown || html) && (
          <Segmented label="Show as" options={MODES} value={mode} onChange={setMode} className={styles.mode} />
        )}
        {inWorkspace && (
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Small}
            icon={faArrowUpRightFromSquare}
            aria-keyshortcuts={openInEditorKeys.ariaKeyShortcuts}
            title={`Open in editor (${openInEditorKeys.label})`}
            aria-label="Open in editor"
            className={styles.openInEditor}
            onClick={() => void openInEditor(taskId, path)}
          >
            <span className={styles.openInEditorLabel}>Open in editor</span>
          </Button>
        )}
      </div>
      {edit?.changedOnDisk === true && (
        <div className={styles.changedOnDisk} role="alert">
          <span className={styles.changedText}>This file changed on disk.</span>
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Small}
            title="Show the file as it is on disk, dropping your edits"
            onClick={() => {
              reloadFile({ taskId, path })
            }}
          >
            Reload
          </Button>
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Small}
            title="Keep your edits: saving writes them over the file on disk"
            onClick={() => {
              keepMyEdits({ taskId, path })
            }}
          >
            Keep mine
          </Button>
        </div>
      )}
      {/*
        Focusable while read-only, so it can be scrolled with the keyboard; the editor takes the focus itself. Either
        way ⌘W closes the file while the focus is in it.
      */}
      <div
        className={editing ? styles.editing : styles.body}
        tabIndex={editing ? undefined : 0}
        aria-label={`${shownPath} contents`}
        role="region"
      >
        {body()}
      </div>
    </div>
  )
}

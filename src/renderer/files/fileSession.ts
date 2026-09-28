/**
 * A workspace file open for editing in the Files tab: its editor's state, the text on disk its edits are measured
 * against, and what's happened on disk since. It outlives the editor showing it, so switching file tabs, or away from
 * the Files tab, keeps your edits (and their undo history, and where you'd scrolled to); it ends when the file's tab
 * closes, or you discard its edits.
 */
import { Transaction, type ChangeSpec, type EditorState, type StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { FileContentKind, type FileContent, type TextFileContent } from '../../shared/domain'
import { createEditorState, markLine, type EditorSetup } from './editorSetup'
import type { EditorHost, EditSession, FileEditState } from './unsaved'

/** A file's content the editor can show and save: text, whole. */
export function isEditable(content: FileContent): content is TextFileContent {
  return content.kind === FileContentKind.Text && !content.truncated
}

/**
 * The one change that turns `from` into `to`: what lies between the text they start and end with. A reload keeps the
 * rest of the document, so the scroll position, the selection and the marks outside the change stay where they are.
 */
export function differingSpan(from: string, to: string): ChangeSpec {
  const shorter = Math.min(from.length, to.length)
  let start = 0
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let end = 0
  while (end < shorter - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
}

/** Keys the editor answers (⌘F finds in the file, say) are its own: they don't go on to the window's shortcuts. */
function keepHandledKeys(event: KeyboardEvent): void {
  if (event.defaultPrevented) event.stopPropagation()
}

export class FileSession implements EditSession {
  private current: EditorState
  private view: EditorView | null = null
  /** Where to scroll to when the editor next shows: where it was left, or the marked line. */
  private scroll: StateEffect<unknown> | null = null
  /** The text on disk the edits are measured against; null when the disk has no text to measure them by. */
  private saved: string | null
  /** What's on disk now, when it changed under unsaved edits. */
  private disk: FileContent | null = null
  private reported: FileEditState = { unsaved: false, changedOnDisk: false }

  constructor(
    setup: EditorSetup,
    /** Hears each change to what the tab shows about the edits. */
    private readonly onEditState: (state: FileEditState) => void,
  ) {
    this.current = createEditorState(setup)
    this.saved = setup.text
  }

  /** The editor's state as it now is. */
  get state(): EditorState {
    return this.current
  }

  get editState(): FileEditState {
    return this.reported
  }

  text(): string {
    return this.current.sliceDoc()
  }

  show(host: EditorHost): () => void {
    /* v8 ignore next -- SourceEditor only ever passes its element */
    if (!(host instanceof HTMLElement)) throw new Error('An editor shows in an element')
    this.hide()
    const view = new EditorView({
      state: this.current,
      parent: host,
      dispatchTransactions: (transactions, target) => {
        target.update(transactions)
        this.current = target.state
        if (transactions.some((transaction) => transaction.docChanged)) this.report()
      },
    })
    view.dom.addEventListener('keydown', keepHandledKeys)
    this.view = view
    if (this.scroll !== null) view.dispatch({ effects: this.scroll })
    return () => {
      if (this.view === view) this.hide()
    }
  }

  markLine(line: number | null): void {
    const { doc } = this.current
    const from = line === null ? null : doc.line(Math.min(Math.max(line, 1), doc.lines)).from
    const scroll = from === null ? [] : [EditorView.scrollIntoView(from, { y: 'center' })]
    if (this.view === null) {
      this.current = this.current.update({ effects: markLine.of(from) }).state
      if (from !== null) this.scroll = scroll[0] ?? null
      return
    }
    this.view.dispatch({ effects: [markLine.of(from), ...scroll] })
  }

  receive(content: FileContent): boolean {
    if (isEditable(content) && content.text === this.saved) {
      this.disk = null
      this.report()
      return true
    }
    if (this.reported.unsaved) {
      this.disk = content
      this.report()
      return true
    }
    if (!isEditable(content)) return false
    this.replace(content.text)
    return true
  }

  reload(): boolean {
    const disk = this.disk
    if (disk === null) return true
    if (!isEditable(disk)) return false
    this.replace(disk.text)
    return true
  }

  keepMine(): void {
    const disk = this.disk
    if (disk === null) return
    this.saved = isEditable(disk) ? disk.text : null
    this.disk = null
    this.report()
  }

  markSaved(text: string): void {
    this.saved = text
    this.disk = null
    this.report()
  }

  /** Takes the editor away, remembering where it was scrolled to. */
  private hide(): void {
    if (this.view === null) return
    this.scroll = this.view.scrollSnapshot()
    this.view.dom.removeEventListener('keydown', keepHandledKeys)
    this.view.destroy()
    this.view = null
  }

  /** Puts `text` in the editor as the file on disk, keeping the scroll position. Not an edit you can undo. */
  private replace(text: string): void {
    this.saved = text
    this.disk = null
    const changes = this.current.changes(differingSpan(this.text(), text))
    const annotations = Transaction.addToHistory.of(false)
    if (this.view === null) {
      this.current = this.current.update({ changes, annotations }).state
      this.scroll = this.scroll?.map(changes) ?? null
    } else {
      const scroll = this.view.scrollSnapshot()
      this.view.dispatch({ changes, annotations })
      this.view.dispatch({ effects: scroll.map(changes) })
    }
    this.report()
  }

  /** Whether the editor's text differs from `saved`: by length first, so typing rarely compares the whole file. */
  private differs(): boolean {
    const saved = this.saved
    if (saved === null) return true
    const { doc, lineBreak } = this.current
    if (doc.length + (doc.lines - 1) * (lineBreak.length - 1) !== saved.length) return true
    return this.text() !== saved
  }

  private report(): void {
    const unsaved = this.differs()
    const changedOnDisk = this.disk !== null
    if (unsaved === this.reported.unsaved && changedOnDisk === this.reported.changedOnDisk) return
    this.reported = { unsaved, changedOnDisk }
    this.onEditState(this.reported)
  }
}

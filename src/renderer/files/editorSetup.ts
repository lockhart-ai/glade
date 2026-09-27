/**
 * The Files tab's editor: CodeMirror 6 with only what plain-text editing needs, and styled entirely from Glade's
 * tokens so that, at rest, it's indistinguishable from the read-only viewer (`SourceView.module.css`,
 * `docs/design/html/08-open-file.html`). No default theme, no `basicSetup`: line numbers, undo history, the drawn
 * selection and caret, find, and the standard keys. No autocomplete, lint, bracket matching, folding or active-line
 * band.
 */
import { history, historyKeymap, indentLess, indentMore, standardKeymap } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, search } from '@codemirror/search'
import {
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type StateCommand,
} from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  gutterLineClass,
  gutters,
  GutterMarker,
  keymap,
  lineNumbers,
  type DecorationSet,
  type KeyBinding,
} from '@codemirror/view'
import { findPanel } from './findPanel'
import { shikiHighlighting } from './editorHighlight'
import type { Language } from './highlight'

/** The line numbers' colour, as the viewer's (`SourceView.module.css`). */
const LINE_NUMBER_COLOR = '#4e5468'

/** The line numbers' column, and the marked line's edge before it: 2px and 44px, as the viewer's. */
const GUTTER_WIDTH = 46

/** The marked line's background and edge, as the viewer's. */
const MARKED_BACKGROUND = 'rgba(91, 141, 239, 0.1)'

/** The class of the marked line, on its text and its number. */
const MARKED_CLASS = 'cm-glade-marked'

/**
 * The editor's look, from Glade's tokens. The viewer lays out each line as a 2px edge, a 44px number column (numbers
 * right-aligned 14px short of it) and the text; here the number's gutter element takes the edge and the column (46px
 * across), and the text starts right after it, as it does there.
 */
export const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'var(--color-text)',
      fontSize: 'var(--font-size-secondary)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--color-text)' },
    '.cm-line': { padding: '0 16px 0 0' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: LINE_NUMBER_COLOR },
    '.cm-lineNumbers .cm-gutterElement': {
      boxSizing: 'border-box',
      width: `${String(GUTTER_WIDTH)}px`,
      minWidth: '0',
      padding: '0 14px 0 0',
      borderLeft: '2px solid transparent',
      textAlign: 'right',
    },
    [`.cm-line.${MARKED_CLASS}`]: { backgroundColor: MARKED_BACKGROUND },
    [`.cm-gutterElement.${MARKED_CLASS}`]: {
      backgroundColor: MARKED_BACKGROUND,
      borderLeftColor: 'var(--color-blue)',
    },
    // A thin caret, and a selection in the app's blue.
    '.cm-cursor, .cm-dropCursor': { borderLeft: '1.5px solid var(--color-text)', marginLeft: '-0.75px' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(91, 141, 239, 0.22)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'rgba(91, 141, 239, 0.32)',
    },
    '.cm-panels': { backgroundColor: 'transparent', color: 'var(--color-text)' },
    '.cm-panels.cm-panels-top': { borderBottom: 'none' },
    '.cm-searchMatch': { backgroundColor: 'rgba(200, 178, 255, 0.2)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(200, 178, 255, 0.42)' },
  },
  { dark: true },
)

/** Marks a line (the agent's `show_file`): its start, or null for none. */
export const markLine = StateEffect.define<number | null>({
  map: (from, changes) => (from === null ? null : changes.mapPos(from)),
})

/** The marked line's start, following the text as it's edited; null for none. */
const markedLine = StateField.define<number | null>({
  create: () => null,
  update(from, transaction) {
    let next = from === null ? null : transaction.changes.mapPos(from)
    for (const effect of transaction.effects) if (effect.is(markLine)) next = effect.value
    return next === null ? null : transaction.state.doc.lineAt(next).from
  },
})

class MarkedNumber extends GutterMarker {
  override elementClass = MARKED_CLASS
}

const MARKED_LINE = Decoration.line({ class: MARKED_CLASS })
const MARKED_NUMBER = new MarkedNumber()

/** The marked line's blue band and edge, over its text and its number, as the viewer draws them. */
const markedLineLook: Extension = [
  markedLine,
  EditorView.decorations.compute([markedLine], (state): DecorationSet => {
    const from = state.field(markedLine)
    return from === null ? Decoration.none : Decoration.set(MARKED_LINE.range(from))
  }),
  gutterLineClass.compute([markedLine], (state) => {
    const from = state.field(markedLine)
    return RangeSet.of<GutterMarker>(from === null ? [] : [MARKED_NUMBER.range(from)])
  }),
]

/**
 * The indentation the file already uses, for Tab: a tab when its lines are indented with tabs, else two or four
 * spaces, whichever its space-indented lines step by (two for a file with none).
 */
export function detectIndentUnit(text: string): string {
  let tabs = 0
  let spaces = 0
  let twos = 0
  for (const [, indent = ''] of text.matchAll(/^([ \t]+)[^ \t\r\n*]/gm)) {
    if (indent.startsWith('\t')) {
      tabs++
      continue
    }
    spaces++
    if (indent.length % 4 === 2) twos++
  }
  if (tabs > spaces) return '\t'
  return spaces > 0 && twos === 0 ? '    ' : '  '
}

/** Tab: indentation at the caret, or the selected lines indented. */
const insertIndent: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore({ state, dispatch })
  const unit = state.facet(indentUnit)
  dispatch(state.update(state.replaceSelection(unit), { scrollIntoView: true, userEvent: 'input.indent' }))
  return true
}

/** The keys: the standard ones (moving, selecting, deleting, ↵), undo and redo, find, and Tab for indentation. */
const EDITOR_KEYS: readonly KeyBinding[] = [
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
  { key: 'Tab', run: insertIndent, shift: indentLess },
  ...standardKeymap,
  ...historyKeymap.filter(({ key }) => key === 'Mod-z' || key === 'Mod-y' || key === 'Mod-Shift-z'),
]

/** What an editor's state starts from. */
export interface EditorSetup {
  /** The file's text, as it is on disk. */
  readonly text: string
  /** The language it's highlighted in; null for plain text. */
  readonly language: Language | null
  /** The editor's accessible name, e.g. `docs/rate-limits.md contents`. */
  readonly label: string
}

/**
 * A number for each line but a final empty one: a file's final newline ends its last line, as the viewer numbers them,
 * so the empty line after it has no number.
 */
function lineNumber(line: number, state: EditorState): string {
  return line > 1 && line === state.doc.lines && state.doc.line(line).length === 0 ? '' : String(line)
}

/** A new editor's state for a file. */
export function createEditorState({ text, language, label }: EditorSetup): EditorState {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(0),
    extensions: [
      // A file with Windows line endings keeps them.
      text.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
      // As the viewer shows tabs: the page's default, 8 columns.
      EditorState.tabSize.of(8),
      indentUnit.of(detectIndentUnit(text)),
      // The numbers scroll sideways with the text, as the viewer's do; bringing the caret into view keeps them in view
      // when it's near the start of its line.
      gutters({ fixed: false }),
      EditorView.scrollMargins.of(() => ({ left: GUTTER_WIDTH })),
      lineNumbers({ formatNumber: lineNumber }),
      history(),
      drawSelection(),
      search({ top: true, createPanel: findPanel }),
      keymap.of(EDITOR_KEYS),
      markedLineLook,
      shikiHighlighting(language),
      editorTheme,
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ],
  })
}

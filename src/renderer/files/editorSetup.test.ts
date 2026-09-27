import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorState, detectIndentUnit, markLine } from './editorSetup'

const views: EditorView[] = []

/** An editor on `text`, showing, with the selection `at` (the caret at the start by default). */
function editorOn(text: string, at?: SelectionRange): EditorView {
  const state = createEditorState({ text, language: null, label: 'notes.txt contents' })
  const view = new EditorView({ state: at === undefined ? state : state.update({ selection: at }).state })
  document.body.append(view.dom)
  views.push(view)
  return view
}

/** Presses a key in an editor, as the keyboard would. */
function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }))
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy()
    view.dom.remove()
  }
})

describe('detectIndentUnit', () => {
  it('indents as the file does: tabs, or two or four spaces', () => {
    expect(detectIndentUnit('def f():\n\treturn 1\n\tpass\n')).toBe('\t')
    expect(detectIndentUnit('def f():\n    if x:\n        return 1\n')).toBe('    ')
    expect(detectIndentUnit('if (x) {\n  if (y) {\n    go()\n  }\n}\n')).toBe('  ')
  })

  it('takes two spaces for a file with no indented lines, or mostly spaces', () => {
    expect(detectIndentUnit('# Title\n\nText.\n')).toBe('  ')
    expect(detectIndentUnit('a:\n  b: 1\n\tc: 2\n  d: 3\n')).toBe('  ')
  })

  it('ignores the stars of a block comment, which sit one space in', () => {
    expect(detectIndentUnit('/**\n * A doc comment.\n */\nfunction f() {\n    return 1\n}\n')).toBe('    ')
  })
})

describe('createEditorState', () => {
  it('starts at the top of the file, showing tabs 8 columns wide as the viewer does, indenting as the file does', () => {
    const state = createEditorState({ text: 'a\n\tb\n', language: null, label: 'a.txt contents' })

    expect(state.doc.toString()).toBe('a\n\tb\n')
    expect(state.selection.main.head).toBe(0)
    expect(state.tabSize).toBe(8)
    expect(state.facet(indentUnit)).toBe('\t')
    expect(state.lineBreak).toBe('\n')
  })

  it('keeps Windows line endings', () => {
    const state = createEditorState({ text: 'a\r\nb\r\n', language: null, label: 'a.txt contents' })

    expect(state.lineBreak).toBe('\r\n')
    expect(state.doc.lines).toBe(3)
    expect(state.sliceDoc()).toBe('a\r\nb\r\n')
  })

  it('keeps the line numbers in view when bringing the start of a line into view', () => {
    const view = editorOn('a\n')

    expect(view.state.facet(EditorView.scrollMargins).map((margins) => margins(view))).toContainEqual({ left: 46 })
  })

  it('names the text you type into for its file', () => {
    const view = editorOn('a\n')

    expect(view.contentDOM).toHaveAttribute('aria-label', 'notes.txt contents')
    expect(view.contentDOM).toHaveAttribute('contenteditable', 'true')
  })
})

describe('the editor’s keys', () => {
  it('Tab puts the file’s indentation at the caret', () => {
    const view = editorOn('ab\n    c\n', EditorSelection.cursor(1))

    press(view, 'Tab')

    expect(view.state.doc.line(1).text).toBe('a    b')
    expect(view.state.selection.main.head).toBe(5)
  })

  it('Tab indents the selected lines, and ⇧Tab takes it away', () => {
    const view = editorOn('one\ntwo\n  three\n', EditorSelection.range(0, 5))

    press(view, 'Tab')
    expect(view.state.doc.toString()).toBe('  one\n  two\n  three\n')
    press(view, 'Tab', { shiftKey: true })
    expect(view.state.doc.toString()).toBe('one\ntwo\n  three\n')
  })

  it('↵ keeps the line’s indentation', () => {
    const view = editorOn('  one\n', EditorSelection.cursor(5))

    press(view, 'Enter')

    expect(view.state.doc.toString()).toBe('  one\n  \n')
  })
})

describe('markLine', () => {
  it('moves with the text when mapped through an edit', () => {
    const state = EditorState.create({ doc: 'one\ntwo\n' })
    const changes = state.changes({ from: 0, insert: 'zero\n' })

    expect(markLine.of(4).map(changes)?.value).toBe(9)
    expect(markLine.of(null).map(changes)?.value).toBeNull()
  })
})

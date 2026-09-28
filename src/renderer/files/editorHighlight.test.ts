import { EditorState, Text } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { colors } from '../tokens'
import { chunkMarks, colours, shikiHighlighting, tokenMark } from './editorHighlight'
import { HIGHLIGHT_CHUNK_LINES, type HighlightToken, type Language } from './highlight'

/** A mark's attributes, as it draws them. */
function attributesOf(mark: Decoration | null | undefined): unknown {
  const spec: unknown = mark?.spec
  return typeof spec === 'object' && spec !== null ? Reflect.get(spec, 'attributes') : undefined
}

function token(content: string, color?: string, bold = false, italic = false): HighlightToken {
  return { content, color, bold, italic }
}

const views: EditorView[] = []

function editorOn(doc: string, language: Language | null): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: shikiHighlighting(language) }) })
  views.push(view)
  return view
}

/** The colour the highlighting gives the text at `pos`, or null for none (yet). */
function colourAt(view: EditorView, pos: number): string | null {
  let found: string | null = null
  view.state.field(colours, false)?.between(pos, pos + 1, (from, to, mark) => {
    if (from <= pos && pos < to) found = /color: (#[0-9a-f]+)/.exec(JSON.stringify(attributesOf(mark)))?.[1] ?? null
  })
  return found
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

describe('tokenMark', () => {
  it('draws a token as the viewer does, one mark per look, and none for plain text', () => {
    const blue = tokenMark(token('const', '#8fb2f5'))
    expect(attributesOf(blue)).toEqual({ style: 'color: #8fb2f5;' })
    expect(tokenMark(token('let', '#8fb2f5'))).toBe(blue)
    expect(attributesOf(tokenMark(token('# Title', '#8fb2f5', true)))).toEqual({
      style: 'color: #8fb2f5;font-weight: 600;',
    })
    expect(attributesOf(tokenMark(token('// note', undefined, false, true)))).toEqual({
      style: 'font-style: italic;',
    })
    expect(tokenMark(token('plain'))).toBeNull()
  })
})

describe('chunkMarks', () => {
  it('places each coloured token on its line, from the chunk’s first line to its last one’s end', () => {
    const doc = Text.of(['zero', 'const x = 1', '', 'let y'])

    const chunk = chunkMarks(doc, 1, [
      [token('const', '#8fb2f5'), token(' x = '), token('1', '#c8b2ff')],
      [],
      [token('let', '#8fb2f5'), token(' y')],
    ])

    expect(chunk.from).toBe(5)
    expect(chunk.to).toBe(doc.length)
    expect(chunk.marks.map(({ from, to }) => [doc.sliceString(from, to), from])).toEqual([
      ['const', 5],
      ['1', 15],
      ['let', 18],
    ])
  })

  it('never marks past a line’s end, nor an empty token', () => {
    const doc = Text.of(['ab', 'c'])

    const chunk = chunkMarks(doc, 0, [[token('', '#8fb2f5'), token('abXYZ', '#8fb2f5')]])

    expect(chunk.marks.map(({ from, to }) => [from, to])).toEqual([[0, 2]])
  })
})

describe('shikiHighlighting', () => {
  it('colours the text as the viewer does', async () => {
    const view = editorOn('// Per key\nconst limit = 120\n', 'typescript')

    await vi.waitFor(() => {
      expect(colourAt(view, 11)).toBe(colors['--color-blue-text'])
    })
    expect(colourAt(view, 3)).toBe(colors['--color-faint'])
    expect(colourAt(view, 25)).toBe(colors['--color-purple'])
    // Plain text has no colour of its own.
    expect(colourAt(view, 17)).toBeNull()
  })

  it('colours a long file a chunk at a time, and again from the chunk an edit is in', async () => {
    const lines = Array.from({ length: HIGHLIGHT_CHUNK_LINES * 2 + 20 }, (_, index) => `let v${String(index)} = 1`)
    const view = editorOn(lines.join('\n'), 'typescript')
    const lastLine = (): number => view.state.doc.line(view.state.doc.lines).from
    await vi.waitFor(() => {
      expect(colourAt(view, lastLine())).toBe(colors['--color-blue-text'])
    })

    // Opening a block comment near the end makes the lines after it a comment, and leaves those before as they were.
    const from = view.state.doc.line(HIGHLIGHT_CHUNK_LINES * 2 + 5).from
    view.dispatch({ changes: { from, insert: '/* ' } })

    await vi.waitFor(() => {
      expect(colourAt(view, lastLine())).toBe(colors['--color-faint'])
    })
    expect(colourAt(view, 0)).toBe(colors['--color-blue-text'])
    expect(colourAt(view, view.state.doc.line(HIGHLIGHT_CHUNK_LINES + 5).from)).toBe(colors['--color-blue-text'])
  })

  it('moves the colours along while an edit waits to be highlighted, and a newer edit takes over', async () => {
    const view = editorOn('const a = 1\n', 'typescript')
    await vi.waitFor(() => {
      expect(colourAt(view, 0)).toBe(colors['--color-blue-text'])
    })

    view.dispatch({ changes: { from: 0, insert: '\n' } })
    view.dispatch({ changes: { from: 0, insert: 'let b = "x"' } })

    expect(colourAt(view, 12)).toBe(colors['--color-blue-text'])
    await vi.waitFor(() => {
      expect(colourAt(view, 0)).toBe(colors['--color-blue-text'])
    })
    expect(colourAt(view, 8)).toBe(colors['--color-teal'])
  })

  it('stops when the editor goes, and leaves a file in no language plain', async () => {
    const view = editorOn('const a = 1\n', 'typescript')
    view.destroy()
    views.splice(views.indexOf(view), 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(colourAt(view, 0)).toBeNull()

    const plain = editorOn('const a = 1\n', null)
    expect(plain.state.field(colours, false)).toBeUndefined()
  })
})

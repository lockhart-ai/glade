/**
 * Syntax highlighting for the Files tab's editor, from the same Shiki tokens the read-only viewer shows (`./highlight`),
 * so a file you edit is coloured exactly as one you only look at. Each token with a colour or a style becomes a mark
 * decoration with that colour and style.
 *
 * Highlighting runs a chunk of lines at a time, off the typing path, as the viewer's does: the file shows at once as
 * plain text and colours in from the top. An edit highlights again from the chunk it's in, carrying on from the
 * grammar's state kept at the start of that chunk, so typing near the end of a long file never re-reads its top.
 * Meanwhile the marks already there move with the text, and each new edit cancels the run before it.
 */
import { StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import {
  HIGHLIGHT_CHUNK_LINES,
  highlight,
  type HighlightedLine,
  type HighlightState,
  type HighlightToken,
  type Language,
} from './highlight'

/** One chunk's marks: the part of the document they colour (from its first line's start to its last line's end). */
interface ColouredChunk {
  readonly from: number
  readonly to: number
  readonly marks: readonly Range<Decoration>[]
}

/** A chunk's marks, for the document as it was when highlighting it started (each edit cancels a run). */
const colourChunk = StateEffect.define<ColouredChunk>()

/** The colours so far, moved along with every edit, each chunk's replaced as highlighting reaches it. */
export const colours = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(colourChunk)) continue
      const { from, to, marks } = effect.value
      next = next.update({ filterFrom: from, filterTo: to, filter: () => false, add: marks })
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const markCache = new Map<string, Decoration>()

/** A token's mark, in its colour and style, as the viewer draws it (`SourceView`); null for plain text. */
export function tokenMark({ color, bold, italic }: HighlightToken): Decoration | null {
  if (color === undefined && !bold && !italic) return null
  const key = `${color ?? ''}|${String(bold)}|${String(italic)}`
  let mark = markCache.get(key)
  if (mark === undefined) {
    const style = [
      color === undefined ? '' : `color: ${color};`,
      bold ? 'font-weight: 600;' : '',
      italic ? 'font-style: italic;' : '',
    ].join('')
    mark = Decoration.mark({ attributes: { style } })
    markCache.set(key, mark)
  }
  return mark
}

/** The marks of a chunk of lines, from `start` (an index from 0) in `doc`. */
export function chunkMarks(doc: Text, start: number, lines: readonly HighlightedLine[]): ColouredChunk {
  const marks: Range<Decoration>[] = []
  const first = doc.line(start + 1)
  let to = first.from
  lines.forEach((tokens, index) => {
    const line = doc.line(start + index + 1)
    let at = line.from
    for (const token of tokens) {
      const end = Math.min(at + token.content.length, line.to)
      const mark = tokenMark(token)
      if (mark !== null && end > at) marks.push(mark.range(at, end))
      at = end
    }
    to = line.to
  })
  return { from: first.from, to, marks }
}

/** Runs highlighting for one editor, again from each edit's chunk. */
class Highlighter {
  private controller: AbortController | null = null
  /** The grammar's state at the start of each chunk highlighted so far, by chunk. */
  private readonly states: HighlightState[] = [undefined]
  /** How many lines from the top are coloured for the document as it now is. */
  private coloured = 0

  constructor(
    private readonly view: EditorView,
    private readonly language: Language,
  ) {
    this.run(0)
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return
    let first = this.coloured
    update.changes.iterChangedRanges((fromA) => {
      first = Math.min(first, update.startState.doc.lineAt(fromA).number - 1)
    })
    this.run(first)
  }

  destroy(): void {
    this.controller?.abort()
  }

  /** Highlights again from the chunk holding line `line` (from 0) to the end. */
  private run(line: number): void {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const chunk = Math.min(Math.floor(line / HIGHLIGHT_CHUNK_LINES), this.states.length - 1)
    this.states.length = chunk + 1
    this.coloured = chunk * HIGHLIGHT_CHUNK_LINES
    const doc = this.view.state.doc
    void highlight(
      doc.toJSON(),
      this.language,
      (start, highlighted, after) => {
        // Any edit aborts the run, so the document is still the one it's highlighting.
        this.states[start / HIGHLIGHT_CHUNK_LINES + 1] = after
        this.coloured = start + highlighted.length
        this.view.dispatch({ effects: colourChunk.of(chunkMarks(doc, start, highlighted)) })
      },
      controller.signal,
      { start: chunk * HIGHLIGHT_CHUNK_LINES, state: this.states[chunk] },
    )
  }
}

/** Highlights the editor's text in `language`, in the viewer's colours; nothing for a file shown as plain text. */
export function shikiHighlighting(language: Language | null): Extension {
  if (language === null) return []
  return [colours, ViewPlugin.define((view) => new Highlighter(view, language))]
}

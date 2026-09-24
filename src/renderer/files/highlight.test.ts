import { describe, expect, it, vi } from 'vitest'
import { colors } from '../tokens'
import {
  HIGHLIGHT_CHUNK_LINES,
  highlight,
  LANGUAGE_NAMES,
  languageOf,
  sourceLines,
  type HighlightedLine,
} from './highlight'

/** Highlights `text`, collecting each line's tokens. */
async function tokens(text: string, language: Parameters<typeof highlight>[1]): Promise<HighlightedLine[]> {
  const lines: HighlightedLine[] = []
  await highlight(
    sourceLines(text),
    language,
    (start, highlighted) => {
      highlighted.forEach((line, index) => (lines[start + index] = line))
    },
    new AbortController().signal,
  )
  return lines
}

/** The colour of the token holding `text` on a line. */
function colorOf(line: HighlightedLine | undefined, text: string): string | undefined {
  return line?.find((token) => token.content.includes(text))?.color?.toLowerCase()
}

describe('languageOf', () => {
  it('knows a language by the file’s extension, or its whole name', () => {
    expect(languageOf('src/date.ts')).toBe('typescript')
    expect(languageOf('api/throttles.py')).toBe('python')
    expect(languageOf('docs/rate-limits.MD')).toBe('markdown')
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('build/Makefile')).toBe('make')
  })

  it('is null for a file shown as plain text', () => {
    expect(languageOf('notes.txt')).toBeNull()
    expect(languageOf('LICENSE')).toBeNull()
    expect(languageOf('.gitignore')).toBeNull()
  })
})

describe('sourceLines', () => {
  it('splits a file into lines, a final newline ending the last one', () => {
    expect(sourceLines('a\nb\n')).toEqual(['a', 'b'])
    expect(sourceLines('a\nb')).toEqual(['a', 'b'])
    expect(sourceLines('a\n\n')).toEqual(['a', ''])
    expect(sourceLines('')).toEqual([''])
  })
})

describe('highlight', () => {
  it('colours code in the design’s colours: keywords blue, strings teal, numbers purple, comments faint', async () => {
    const lines = await tokens('// Per key\nconst limit = 120\nconst name = "search"\n', 'typescript')

    expect(colorOf(lines[0], 'Per key')).toBe(colors['--color-faint'])
    expect(lines[0]?.[0]?.italic).toBe(true)
    expect(colorOf(lines[1], 'const')).toBe(colors['--color-blue-text'])
    expect(colorOf(lines[1], '120')).toBe(colors['--color-purple'])
    expect(colorOf(lines[2], 'search')).toBe(colors['--color-teal'])
    // Plain text takes the text colour, so it has none of its own.
    expect(lines[1]?.find((token) => token.content.includes('limit'))?.color).toBeUndefined()
  })

  it('colours Markdown as the design does: headings bold blue, inline code purple, code blocks teal', async () => {
    const lines = await tokens('# Rate limits\n\nUse `Retry-After`.\n\n```http\nRetry-After: 17\n```\n', 'markdown')

    expect(colorOf(lines[0], 'Rate limits')).toBe(colors['--color-blue-text'])
    expect(lines[0]?.find((token) => token.content.includes('Rate'))?.bold).toBe(true)
    expect(colorOf(lines[2], 'Retry-After')).toBe(colors['--color-purple'])
    expect(colorOf(lines[5], 'Retry-After: 17')).toBe(colors['--color-teal'])

    const table = await tokens('| Endpoint | Limit |\n|----------|-------|\n', 'markdown')
    expect(table[0]?.[0]).toMatchObject({ content: '|', color: colors['--color-faint'] })
    expect(colorOf(table[1], '---')).toBe(colors['--color-faint'])
  })

  it('colours a long file a chunk at a time, carrying the grammar across chunks, and stops when aborted', async () => {
    const source = ['/*', ...Array.from({ length: HIGHLIGHT_CHUNK_LINES + 10 }, () => ' * still a comment'), ' */']
    const chunks: number[] = []
    const lines: HighlightedLine[] = []
    await highlight(
      source,
      'typescript',
      (start, highlighted) => {
        chunks.push(start)
        highlighted.forEach((line, index) => (lines[start + index] = line))
      },
      new AbortController().signal,
    )

    expect(chunks).toEqual([0, HIGHLIGHT_CHUNK_LINES])
    expect(colorOf(lines[HIGHLIGHT_CHUNK_LINES + 5], 'still a comment')).toBe(colors['--color-faint'])

    const controller = new AbortController()
    const onLines = vi.fn(() => {
      controller.abort()
    })
    await highlight(source, 'typescript', onLines, controller.signal)
    expect(onLines).toHaveBeenCalledOnce()
  })
})

describe('every language', () => {
  it('loads its grammar and highlights with the JavaScript regex engine', async () => {
    for (const language of LANGUAGE_NAMES) {
      const lines = await tokens('x = 1 # a line\n', language)
      expect(
        lines.map((line) => line.map((token) => token.content).join('')),
        language,
      ).toEqual(['x = 1 # a line'])
    }
  }, 60_000)
})

import { describe, expect, it } from 'vitest'
import type { PastedBlock } from './domain'
import {
  agentText,
  insertPastedBlock,
  isPasteWorthMarking,
  messageSegments,
  PASTE_LENGTH_THRESHOLD,
  pasteToken,
  pasteTokenRanges,
  pastedLineCount,
  randomPasteId,
  reconcilePastedBlocks,
  removePastedBlock,
  tokenEndingAt,
  tokenStartingAt,
  updatePastedBlock,
  wrapPastedBlock,
} from './pastedContent'

describe('isPasteWorthMarking', () => {
  it('leaves a short single line as plain typed text', () => {
    expect(isPasteWorthMarking('a')).toBe(false)
    expect(isPasteWorthMarking('/code/acme-api/src/main.ts')).toBe(false)
    expect(isPasteWorthMarking('x'.repeat(PASTE_LENGTH_THRESHOLD - 1))).toBe(false)
  })

  it('marks a single line at the threshold or over', () => {
    expect(isPasteWorthMarking('x'.repeat(PASTE_LENGTH_THRESHOLD))).toBe(true)
    expect(isPasteWorthMarking('x'.repeat(PASTE_LENGTH_THRESHOLD + 20))).toBe(true)
  })

  it('marks more than one line, however short', () => {
    expect(isPasteWorthMarking('a\nb')).toBe(true)
  })

  it("doesn't count a single trailing newline as a second line", () => {
    expect(isPasteWorthMarking('one line\n')).toBe(false)
    expect(isPasteWorthMarking('one line\n\n')).toBe(true)
  })
})

describe('pasteToken', () => {
  it('says how many lines, singular for one', () => {
    expect(pasteToken('one line of 80+ chars '.padEnd(90, 'x'))).toBe('[Pasted text · 1 line]')
    expect(pasteToken('a\nb\nc')).toBe('[Pasted text · 3 lines]')
  })
})

describe('randomPasteId', () => {
  it('is a short, lowercase alphanumeric id, different each time', () => {
    const id = randomPasteId()
    expect(id).toMatch(/^[a-z0-9]{6}$/)
    expect(randomPasteId()).not.toBe(id)
  })
})

describe('messageSegments', () => {
  const block: PastedBlock = { id: 'k3f9', text: 'the pasted text' }

  it('is one typed segment for text with no token', () => {
    expect(messageSegments('hello there', [])).toEqual([{ kind: 'typed', text: 'hello there' }])
  })

  it('is one typed segment (empty) for an empty body', () => {
    expect(messageSegments('', [])).toEqual([{ kind: 'typed', text: '' }])
  })

  it('matches a token to its block by position, with typed text around it', () => {
    const body = `before ${pasteToken(block.text)} after`
    expect(messageSegments(body, [block])).toEqual([
      { kind: 'typed', text: 'before ' },
      { kind: 'pasted', block },
      { kind: 'typed', text: ' after' },
    ])
  })

  it('is just the pasted segment when the token is the whole body', () => {
    expect(messageSegments(pasteToken(block.text), [block])).toEqual([{ kind: 'pasted', block }])
  })

  it('matches several tokens to their blocks in order, even when two blocks are the same length', () => {
    const a: PastedBlock = { id: 'aaa', text: 'aa\nbb' }
    const b: PastedBlock = { id: 'bbb', text: 'cc\ndd' }
    const body = `${pasteToken(a.text)} and ${pasteToken(b.text)}`
    expect(messageSegments(body, [a, b])).toEqual([
      { kind: 'pasted', block: a },
      { kind: 'typed', text: ' and ' },
      { kind: 'pasted', block: b },
    ])
  })

  it('keeps a token as plain text when it has no block left for it, rather than dropping it', () => {
    const body = pasteToken('a\nb')
    expect(messageSegments(body, [])).toEqual([{ kind: 'typed', text: body }])
  })
})

describe('wrapPastedBlock and agentText', () => {
  it('wraps a block in matching opening and closing tags, each carrying its id', () => {
    const block: PastedBlock = { id: 'k3f9', text: 'line one\nline two' }
    expect(wrapPastedBlock(block)).toBe('<pasted_content id="k3f9">\nline one\nline two\n</pasted_content id="k3f9">')
  })

  it('sends typed text as usual, with each pasted block wrapped at its place among it', () => {
    const block: PastedBlock = { id: 'k3f9', text: 'the error' }
    const body = `Here's the error: ${pasteToken(block.text)} any ideas?`
    expect(agentText(body, [block])).toBe(
      `Here's the error: <pasted_content id="k3f9">\nthe error\n</pasted_content id="k3f9"> any ideas?`,
    )
  })

  it('is just the typed text when there are no pasted blocks', () => {
    expect(agentText('plain text, nothing pasted', [])).toBe('plain text, nothing pasted')
  })
})

describe('insertPastedBlock', () => {
  it('splices a token in at the caret, and the block at the matching position', () => {
    const first = insertPastedBlock('before  after', [], 7, 7, 'a\nb\nc')
    expect(first.text).toBe('before [Pasted text · 3 lines] after')
    expect(first.blocks).toEqual([{ id: expect.any(String) as string, text: 'a\nb\nc' }])
    expect(first.caret).toBe(7 + pasteToken('a\nb\nc').length)
  })

  it('replaces a selection, as a paste normally does', () => {
    const result = insertPastedBlock('before SELECTED after', [], 7, 15, 'x\ny')
    expect(result.text).toBe(`before ${pasteToken('x\ny')} after`)
  })

  it('keeps blocks in the order their tokens appear, inserting between two existing ones', () => {
    const a: PastedBlock = { id: 'a1', text: 'a\na' }
    const b: PastedBlock = { id: 'b1', text: 'b\nb' }
    const body = `${pasteToken(a.text)}, ${pasteToken(b.text)}`
    const middle = body.indexOf(', ') + 1
    const result = insertPastedBlock(body, [a, b], middle, middle, 'c\nc')
    expect(result.blocks.map((block) => block.text)).toEqual(['a\na', 'c\nc', 'b\nb'])
  })
})

describe('removePastedBlock', () => {
  it('removes a token and its block by id, wherever the token is', () => {
    const a: PastedBlock = { id: 'a1', text: 'aa\naa' }
    const b: PastedBlock = { id: 'b1', text: 'bb\nbb' }
    const body = `x ${pasteToken(a.text)} y ${pasteToken(b.text)} z`
    const result = removePastedBlock(body, [a, b], 'a1')
    expect(result.text).toBe(`x  y ${pasteToken(b.text)} z`)
    expect(result.blocks).toEqual([b])
  })

  it('does nothing for a block that is not there (any more)', () => {
    const result = removePastedBlock('plain text', [], 'missing')
    expect(result).toEqual({ text: 'plain text', blocks: [] })
  })
})

describe('updatePastedBlock', () => {
  it("regenerates a block's token in place when its text (and so its line count) changes", () => {
    const block: PastedBlock = { id: 'k3f9', text: 'one line' }
    const body = `before ${pasteToken(block.text)} after`
    const result = updatePastedBlock(body, [block], 'k3f9', 'now\nthree\nlines')
    expect(result.text).toBe(`before ${pasteToken('now\nthree\nlines')} after`)
    expect(result.blocks).toEqual([{ id: 'k3f9', text: 'now\nthree\nlines' }])
  })
})

describe('reconcilePastedBlocks', () => {
  const block: PastedBlock = { id: 'k3f9', text: 'a\nb' }

  it('keeps a block whose token is wholly outside the edited span', () => {
    const before = `x ${pasteToken(block.text)} y`
    const after = `xx ${pasteToken(block.text)} y`
    expect(reconcilePastedBlocks(before, after, [block])).toEqual([block])
  })

  it('drops a block whose token was typed into (backspaced, or overwritten by a selection)', () => {
    const before = `x ${pasteToken(block.text)} y`
    // Backspacing the last character off the token.
    const after = before.slice(0, -3) + before.slice(-2)
    expect(reconcilePastedBlocks(before, after, [block])).toEqual([])
  })

  it('is the same array reference when nothing changed, so callers can skip a re-render', () => {
    const before = `x ${pasteToken(block.text)} y`
    const blocks = [block]
    expect(reconcilePastedBlocks(before, before, blocks)).toBe(blocks)
  })
})

describe('tokenEndingAt and tokenStartingAt', () => {
  it('finds the token right before or after a position, and which block it is, for atomic Backspace and Delete', () => {
    const block: PastedBlock = { id: 'k3f9', text: 'a\nb' }
    const token = pasteToken(block.text)
    const text = `x ${token} y`
    const start = 2
    const end = start + token.length
    expect(tokenEndingAt(text, [block], end)).toEqual({ start, end, block })
    expect(tokenStartingAt(text, [block], start)).toEqual({ start, end, block })
    expect(tokenEndingAt(text, [block], end - 1)).toBeNull()
    expect(tokenStartingAt(text, [block], start + 1)).toBeNull()
  })

  it('is null when the position matches a token but there is no block left for it', () => {
    const token = pasteToken('a\nb')
    const text = `x ${token} y`
    expect(tokenEndingAt(text, [], 2 + token.length)).toBeNull()
    expect(tokenStartingAt(text, [], 2)).toBeNull()
  })
})

describe('pasteTokenRanges', () => {
  it('is empty for text with no token', () => {
    expect(pasteTokenRanges('hello there')).toEqual([])
    expect(pasteTokenRanges('')).toEqual([])
  })

  it('is one range for one token, at its exact position', () => {
    const token = pasteToken('a\nb')
    const text = `before ${token} after`
    const start = 'before '.length
    expect(pasteTokenRanges(text)).toEqual([{ start, end: start + token.length }])
    expect(text.slice(start, start + token.length)).toBe(token)
  })

  it('is a range per token, in order, for several', () => {
    const a = pasteToken('a\nb')
    const b = pasteToken('c\nd\ne')
    const text = `${a} and ${b}`
    const ranges = pasteTokenRanges(text)
    expect(ranges).toHaveLength(2)
    expect(text.slice(ranges[0]?.start, ranges[0]?.end)).toBe(a)
    expect(text.slice(ranges[1]?.start, ranges[1]?.end)).toBe(b)
  })
})

describe('pastedLineCount', () => {
  it('counts lines, not counting one trailing newline', () => {
    expect(pastedLineCount('a')).toBe(1)
    expect(pastedLineCount('a\nb')).toBe(2)
    expect(pastedLineCount('a\nb\n')).toBe(2)
    expect(pastedLineCount('a\nb\n\n')).toBe(3)
  })
})

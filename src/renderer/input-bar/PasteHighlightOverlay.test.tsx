import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { pasteToken } from '../../shared/pastedContent'
import { PasteHighlightOverlay } from './PasteHighlightOverlay'

function overlay(): HTMLElement {
  return screen.getByTestId('paste-highlight-overlay')
}

describe('PasteHighlightOverlay', () => {
  it('is hidden from the accessibility tree: purely visual, behind the real field', () => {
    render(<PasteHighlightOverlay text="hello" />)
    expect(overlay()).toHaveAttribute('aria-hidden', 'true')
  })

  it('mirrors plain text with no highlight when there is no token', () => {
    render(<PasteHighlightOverlay text="hello there" />)
    expect(overlay()).toHaveTextContent('hello there')
    expect(overlay().querySelector('mark')).toBeNull()
  })

  it('mirrors empty text as an empty overlay', () => {
    render(<PasteHighlightOverlay text="" />)
    expect(overlay()).toHaveTextContent('')
    expect(overlay().querySelector('mark')).toBeNull()
  })

  it('highlights a token in a <mark>, with the typed text around it not marked', () => {
    const token = pasteToken('a\nb\nc')
    render(<PasteHighlightOverlay text={`before ${token} after`} />)

    const marks = overlay().querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent(token)
    expect(overlay()).toHaveTextContent(`before ${token} after`)
  })

  it('is just the highlighted token when the token is the whole text', () => {
    const token = pasteToken('a\nb')
    render(<PasteHighlightOverlay text={token} />)

    const marks = overlay().querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent(token)
  })

  it('highlights several tokens, each in its own <mark>, at their own place', () => {
    const a = pasteToken('a\nb')
    const b = pasteToken('c\nd\ne')
    render(<PasteHighlightOverlay text={`${a} and ${b}`} />)

    const marks = overlay().querySelectorAll('mark')
    expect(marks).toHaveLength(2)
    expect(marks[0]).toHaveTextContent(a)
    expect(marks[1]).toHaveTextContent(b)
  })
})

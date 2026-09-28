import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { highlightPattern } from '../../shared/search'
import { storeWrapper } from '../store/test-wrapper'
import { LinkedText } from './LinkedText'

function renderText(text: string, pattern: RegExp | null = null, main: { opened?: string[]; copied?: string[] } = {}) {
  const { container } = render(
    <p>
      <LinkedText text={text} pattern={pattern} />
    </p>,
    { wrapper: storeWrapper(main).wrapper },
  )
  return container.firstElementChild as HTMLElement
}

describe('LinkedText', () => {
  it('shows plain text as it is, with its bare URLs and addresses as links', () => {
    const root = renderText(
      'Preview at http://localhost:4173, docs in [setup](docs/setup.md), mail support@example.com',
    )

    expect(root).toHaveTextContent(
      'Preview at http://localhost:4173, docs in [setup](docs/setup.md), mail support@example.com',
    )
    expect(
      within(root)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('title')]),
    ).toEqual([
      ['http://localhost:4173', 'http://localhost:4173/', null],
      ['support@example.com', 'mailto:support@example.com', null],
    ])
  })

  it('shows text without links as text alone', () => {
    const root = renderText('Copy the 3,900 existing files')

    expect(root.innerHTML).toBe('Copy the 3,900 existing files')
  })

  it('keeps a URL in backticks plain', () => {
    const root = renderText('Ran `curl https://example.com/api` twice')

    expect(within(root).queryByRole('link')).toBeNull()
    expect(root).toHaveTextContent('Ran `curl https://example.com/api` twice')
  })

  it('marks what the search matches, inside and outside the links', () => {
    const root = renderText('The docs: https://example.com/docs', highlightPattern('docs'))

    expect(Array.from(root.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['docs', 'docs'])
    expect(within(root).getByRole('link').querySelector('mark')).toHaveTextContent('docs')
  })

  it('opens a link through main, and copies it from its menu', async () => {
    const opened: string[] = []
    const copied: string[] = []
    const root = renderText('Deployed to https://example.com/app.', null, { opened, copied })
    const link = within(root).getByRole('link', { name: 'https://example.com/app' })

    fireEvent.click(link)
    fireEvent.contextMenu(link)
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Link actions' })).getByRole('menuitem', { name: 'Copy link' }),
    )

    await waitFor(() => {
      expect(opened).toEqual(['https://example.com/app'])
      expect(copied).toEqual(['https://example.com/app'])
    })
  })
})

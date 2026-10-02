import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ArtifactKind, UiStateKey, type Artifact } from '../../shared/domain'
import { highlightPattern } from '../../shared/search'
import { storeWrapper } from '../store/test-wrapper'
import { Link } from './Link'
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

  describe('Add to artifacts (#407)', () => {
    const PR = 'https://github.com/acme/api/pull/412'

    /** A task `t1`, open, with these artifacts, hydrated. */
    async function openTask(artifacts: readonly Artifact[] = []) {
      const wrapper = storeWrapper({
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
        ],
        artifacts,
      })
      await act(() => wrapper.store.getState().hydrate())
      await act(() => wrapper.store.getState().loadHistory('t1'))
      return wrapper
    }

    /** The items of a link's menu, opened by a right-click. */
    function menuOf(link: HTMLElement): string[] {
      fireEvent.contextMenu(link)
      const menu = screen.getByRole('menu', { name: 'Link actions' })
      return within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    }

    it('adds a web link to the open task’s artifacts, called its #N, and then no longer offers to', async () => {
      const wrapper = await openTask()
      render(<LinkedText text={`Opened ${PR} for review.`} />, { wrapper: wrapper.wrapper })
      const link = screen.getByRole('link', { name: PR })

      expect(menuOf(link)).toEqual(['Open link', 'Copy link', 'Add to artifacts'])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add to artifacts' }))

      await waitFor(() => {
        expect(wrapper.store.getState().artifacts.t1).toEqual([
          expect.objectContaining({ kind: ArtifactKind.Link, url: PR, title: '#412' }),
        ])
      })
      expect(menuOf(link)).toEqual(['Open link', 'Copy link'])
    })

    it('is called what a Markdown-style link says', async () => {
      const wrapper = await openTask()
      render(
        <Link href="https://example.com/style" text="Code sample style guide">
          Code sample style guide
        </Link>,
        {
          wrapper: wrapper.wrapper,
        },
      )

      fireEvent.contextMenu(screen.getByRole('link', { name: 'Code sample style guide' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add to artifacts' }))

      await waitFor(() => {
        expect(wrapper.store.getState().artifacts.t1?.map(({ title }) => title)).toEqual(['Code sample style guide'])
      })
    })

    it('isn’t offered for a mail link, or one already among the task’s artifacts', async () => {
      const added: Artifact = { kind: ArtifactKind.Link, taskId: 't1', url: PR, title: 'PR', addedAt: 1, updatedAt: 1 }
      const wrapper = await openTask([added])
      render(<LinkedText text={`${PR} and support@example.com`} />, { wrapper: wrapper.wrapper })

      expect(menuOf(screen.getByRole('link', { name: PR }))).toEqual(['Open link', 'Copy link'])
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(menuOf(screen.getByRole('link', { name: 'support@example.com' }))).toEqual(['Open link', 'Copy link'])
    })

    it('isn’t offered with no task open', () => {
      renderText('See https://example.com/docs')

      expect(menuOf(screen.getByRole('link', { name: 'https://example.com/docs' }))).toEqual(['Open link', 'Copy link'])
    })
  })
})

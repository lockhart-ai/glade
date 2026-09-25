import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TaskHandoff } from '../../shared/domain'
import { HandoffCard, handoffLine } from './HandoffCard'

const ADDED_AT = new Date(2026, 8, 25, 9, 14).getTime()

function handoff(body: string): TaskHandoff {
  return { taskId: 't1', body, addedAt: ADDED_AT }
}

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Backfilled' })
}

function toggle(): HTMLElement {
  return within(card()).getByRole('button', { name: /^Backfilled/ })
}

describe('HandoffCard', () => {
  it('says it was backfilled, and when the note was added', () => {
    expect(handoffLine(handoff('Notes'))).toBe('handoff from earlier notes, added Sep 25')

    render(<HandoffCard handoff={handoff('Notes')} />)

    expect(toggle()).toHaveTextContent('Backfilled·handoff from earlier notes, added Sep 25')
  })

  it('starts open on the note as Markdown, and its line closes and opens it again', () => {
    render(<HandoffCard handoff={handoff('## Where it got to\n\nThe `invoice.*` handlers are **live**.')} />)

    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(within(card()).getByRole('heading', { name: 'Where it got to', level: 2 })).toBeInTheDocument()
    expect(within(card()).getByText('live').tagName).toBe('STRONG')
    expect(within(card()).getByText('invoice.*').tagName).toBe('CODE')
    const body = document.getElementById(toggle().getAttribute('aria-controls') ?? '')
    expect(body).toHaveTextContent('The invoice.* handlers are live.')

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(within(card()).queryByText('live')).toBeNull()
    expect(card()).toHaveTextContent('Backfilled·handoff from earlier notes, added Sep 25')

    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(within(card()).getByText('live')).toBeInTheDocument()
  })

  it('shows a code fence as a code block, keeping the HTML inside it as text', () => {
    render(<HandoffCard handoff={handoff('Run this:\n\n```html\n<script>alert(1)</script>\n```')} />)

    const block = card().querySelector('pre code')
    expect(block).toHaveTextContent('<script>alert(1)</script>')
    expect(card().querySelector('script')).toBeNull()
  })

  it('drops raw HTML, loads nothing and follows no link', () => {
    render(
      <HandoffCard
        handoff={handoff(
          [
            'Before <b>bold</b> after.',
            '',
            '<img src="https://example.com/x.png" onerror="alert(1)">',
            '',
            '<script>alert(1)</script>',
            '',
            '![the plan](https://example.com/plan.png) and [the notes](file:///code/api/notes.md)',
          ].join('\n'),
        )}
      />,
    )

    expect(card().querySelector('b, img, script, a, iframe')).toBeNull()
    expect(card()).toHaveTextContent('Before bold after.')
    expect(card()).toHaveTextContent('the plan and the notes')
    expect(card().innerHTML).not.toContain('example.com')
    expect(card().innerHTML).not.toContain('onerror')
  })

  it('renders a long note whole', () => {
    const body = Array.from({ length: 800 }, (_, index) => `- Step ${String(index)}: notes/step-${String(index)}.md`)
    render(<HandoffCard handoff={handoff(body.join('\n'))} />)

    expect(within(card()).getAllByRole('listitem')).toHaveLength(800)
  })
})

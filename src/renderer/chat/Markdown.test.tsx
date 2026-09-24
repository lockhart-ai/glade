import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Markdown } from './Markdown'

function renderMarkdown(source: string): HTMLElement {
  const { container } = render(<Markdown source={source} className="extra" />)
  return container.firstElementChild as HTMLElement
}

it('renders Markdown, with GitHub tables, task lists and strikethrough', () => {
  const root = renderMarkdown(
    [
      '# Plan',
      'Use **DRF** throttling, not _middleware_. ~~Old idea~~',
      '- [x] Write the class',
      '- [ ] Pick a /search limit',
      '| Endpoint | Limit |\n| --- | --- |\n| /search | 60 |',
    ].join('\n\n'),
  )

  expect(root).toHaveClass('extra')
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
  expect(screen.getByText('DRF').tagName).toBe('STRONG')
  expect(screen.getByText('middleware').tagName).toBe('EM')
  expect(screen.getByText('Old idea').tagName).toBe('DEL')
  expect(screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false])
  expect(screen.getByRole('table')).toHaveTextContent('/search60')
})

it('styles inline code and code blocks as code', () => {
  const root = renderMarkdown('Run `pytest -q`:\n\n```python\nassert limit == 60\n```')

  expect(screen.getByText('pytest -q').tagName).toBe('CODE')
  const block = root.querySelector('pre > code')
  expect(block).toHaveTextContent('assert limit == 60')
})

it('shows a link as its text, with nothing to follow', () => {
  const root = renderMarkdown('See [the docs](https://example.com/docs) or <https://example.com>.')

  expect(root.querySelector('a')).toBeNull()
  expect(root.querySelector('[href]')).toBeNull()
  expect(root).toHaveTextContent('See the docs or https://example.com.')
})

it('never loads an image: it shows the alt text instead', () => {
  const root = renderMarkdown('![A diagram](https://example.com/diagram.png)\n\n![](data:image/png;base64,AAAA)')

  expect(root.querySelector('img')).toBeNull()
  expect(root.querySelector('[src]')).toBeNull()
  expect(root).toHaveTextContent('A diagram')
})

it('drops raw HTML tags, keeping only the text between them', () => {
  const root = renderMarkdown(
    'Before <img src="https://example.com/x.png"> <script>alert(1)</script> after\n\n<div>block</div>',
  )

  expect(root.querySelector('img, script, div div')).toBeNull()
  expect(root).toHaveTextContent('Before alert(1) after')
  expect(root).not.toHaveTextContent('block')
})

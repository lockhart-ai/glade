import { fireEvent, render as renderUnwrapped, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { refuse } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { InlineMarkdown, Markdown } from './Markdown'

/** Renders under a store, which the links open and copy through. */
function render(ui: React.ReactElement, wrapper: StoreWrapper = storeWrapper()) {
  return renderUnwrapped(ui, { wrapper: wrapper.wrapper })
}

function renderMarkdown(source: string, wrapper?: StoreWrapper, highlight?: RegExp): HTMLElement {
  const { container } = render(
    <Markdown source={source} className="extra" {...(highlight === undefined ? {} : { highlight })} />,
    wrapper,
  )
  return container.firstElementChild as HTMLElement
}

interface ShownLink {
  readonly text: string | null
  readonly href: string | null
}

/** The links shown, each as its text and address. */
function links(root: HTMLElement): ShownLink[] {
  return within(root)
    .queryAllByRole('link')
    .map((link) => ({ text: link.textContent, href: link.getAttribute('href') }))
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

describe('links', () => {
  it('makes a Markdown link, an autolink, and bare URLs and email addresses links', () => {
    const root = renderMarkdown(
      'See [the docs](https://example.com/docs), <https://example.com/status>, https://example.com/changelog. ' +
        'Or www.example.com, or mail support@example.com (http://localhost:4173).',
    )

    expect(links(root)).toEqual([
      { text: 'the docs', href: 'https://example.com/docs' },
      { text: 'https://example.com/status', href: 'https://example.com/status' },
      { text: 'https://example.com/changelog', href: 'https://example.com/changelog' },
      { text: 'www.example.com', href: 'http://www.example.com/' },
      { text: 'support@example.com', href: 'mailto:support@example.com' },
      { text: 'http://localhost:4173', href: 'http://localhost:4173/' },
    ])
    expect(root).toHaveTextContent(
      'See the docs, https://example.com/status, https://example.com/changelog. Or www.example.com, or mail ' +
        'support@example.com (http://localhost:4173).',
    )
  })

  it('shows the address on hover when the text says something else', () => {
    const root = renderMarkdown(
      '[the docs](https://example.com/docs) [the status page](https://example.com/status "Status") ' +
        'https://example.com/changelog support@example.com www.example.com [https://example.com](https://example.com)',
    )

    expect(within(root).getByRole('link', { name: 'the docs' })).toHaveAttribute('title', 'https://example.com/docs')
    expect(within(root).getByRole('link', { name: 'the status page' })).toHaveAttribute(
      'title',
      'https://example.com/status',
    )
    for (const name of ['https://example.com/changelog', 'support@example.com', 'www.example.com']) {
      expect(within(root).getByRole('link', { name })).not.toHaveAttribute('title')
    }
    expect(within(root).getByRole('link', { name: 'https://example.com' })).not.toHaveAttribute('title')
  })

  it('keeps code spans and code blocks plain, URLs and all', () => {
    const root = renderMarkdown(
      'Run `curl https://example.com/api` first.\n\n```sh\nopen https://example.com/docs\n```\n\n    https://example.com/indented',
    )

    expect(links(root)).toEqual([])
    expect(screen.getByText('curl https://example.com/api').tagName).toBe('CODE')
    expect(root.querySelectorAll('pre')).toHaveLength(2)
    expect(root).toHaveTextContent('open https://example.com/docs')
    expect(root).toHaveTextContent('https://example.com/indented')
  })

  it('shows a link Glade won’t open as its text, with no address on the page', () => {
    const root = renderMarkdown(
      [
        '[setup](docs/setup.md)',
        '[limits](#limits)',
        '[run](javascript:alert(1))',
        '[mixed](JaVaScRiPt:alert(1))',
        '[passwords](file:///etc/passwd)',
        '[page](data:text/html,hi)',
        '[task](glade://task/t1)',
        '<mailto:support@example.com>',
      ].join(' '),
    )

    expect(links(root)).toEqual([{ text: 'mailto:support@example.com', href: 'mailto:support@example.com' }])
    expect(root.querySelectorAll('[href]')).toHaveLength(1)
    expect(root).toHaveTextContent('setup limits run mixed passwords page task mailto:support@example.com')
  })

  it('opens a link in the browser through main when it’s clicked or ⌘-clicked, never in the window', async () => {
    const opened: string[] = []
    const root = renderMarkdown(
      'See [the docs](https://example.com/docs) and https://example.com/status.',
      storeWrapper({ opened }),
    )

    const docs = within(root).getByRole('link', { name: 'the docs' })
    // `fireEvent` answers false when the click's default (following the link) was prevented.
    expect(fireEvent.click(docs)).toBe(false)
    const status = within(root).getByRole('link', { name: 'https://example.com/status' })
    expect(fireEvent.click(status, { metaKey: true })).toBe(false)

    await waitFor(() => {
      expect(opened).toEqual(['https://example.com/docs', 'https://example.com/status'])
    })
    // A link is in the tab order, as any link with an address is, and ↵ on it clicks it.
    expect(docs.tabIndex).toBe(0)
  })

  it('says why when main won’t open it', async () => {
    const wrapper = storeWrapper(
      {},
      { [CommandName.LinksOpen]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'No application to open it')) },
    )
    const root = renderMarkdown('[the docs](https://example.com/docs)', wrapper)

    fireEvent.click(within(root).getByRole('link', { name: 'the docs' }))

    expect(await screen.findByText(/No application to open it/)).toBeInTheDocument()
  })

  it('has its own menu, which opens it or copies its address', async () => {
    const opened: string[] = []
    const copied: string[] = []
    const root = renderMarkdown('[the docs](https://example.com/docs)', storeWrapper({ opened, copied }))
    const link = within(root).getByRole('link', { name: 'the docs' })

    fireEvent.contextMenu(link)
    const menu = screen.getByRole('menu', { name: 'Link actions' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open link', 'Copy link'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => {
      expect(copied).toEqual(['https://example.com/docs'])
    })
    // Choosing an item doesn't click the link as well.
    expect(opened).toEqual([])

    link.focus()
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true })
    const again = screen.getByRole('menu', { name: 'Link actions' })
    fireEvent.click(within(again).getByRole('menuitem', { name: 'Open link' }))
    await waitFor(() => {
      expect(opened).toEqual(['https://example.com/docs'])
    })
    expect(screen.queryByRole('menu', { name: 'Link actions' })).toBeNull()
  })

  it('marks what the search matches inside a link too', () => {
    const root = renderMarkdown(
      'See [the docs](https://example.com/docs) at https://example.com/docs.',
      undefined,
      /docs/gi,
    )

    const [named, bare] = within(root).getAllByRole('link')
    expect(named?.querySelector('mark')).toHaveTextContent('docs')
    expect(bare?.querySelectorAll('mark')).toHaveLength(1)
    expect(bare).toHaveAttribute('href', 'https://example.com/docs')
    expect(bare).toHaveTextContent('https://example.com/docs')
  })
})

it('never loads an image: it shows the alt text instead', () => {
  const root = renderMarkdown('![A diagram](https://example.com/diagram.png)\n\n![](data:image/png;base64,AAAA)')

  expect(root.querySelector('img')).toBeNull()
  expect(root.querySelector('[src]')).toBeNull()
  expect(root).toHaveTextContent('A diagram')
})

it('drops raw HTML tags, keeping only the text between them', () => {
  const root = renderMarkdown(
    'Before <img src="https://example.com/x.png"> <script>alert(1)</script> after\n\n<div>block</div> <a href="https://example.com">raw</a>',
  )

  expect(root.querySelector('img, script, div div, [href]')).toBeNull()
  expect(root).toHaveTextContent('Before alert(1) after')
  expect(root).not.toHaveTextContent('block')
})

describe('InlineMarkdown', () => {
  function renderInline(source: string): HTMLElement {
    const { container } = render(
      <p>
        <InlineMarkdown source={source} />
      </p>,
    )
    return container.firstElementChild as HTMLElement
  }

  it('keeps inline code and emphasis, inline', () => {
    const root = renderInline('Uses `django-storages`, *not* **boto** directly.')

    expect(screen.getByText('django-storages').tagName).toBe('CODE')
    expect(screen.getByText('not').tagName).toBe('EM')
    expect(screen.getByText('boto').tagName).toBe('STRONG')
    expect(root.children).toHaveLength(3)
    expect(root).toHaveTextContent('Uses django-storages, not boto directly.')
  })

  it('shows images, headings, lists and blocks as their text, and runs paragraphs on', () => {
    const root = renderInline(
      '# Plan\n\nSee the docs and ![a diagram](https://example.com/d.png).\n\n- one\n- two\n\n```\nmake\n```\n\n<b>raw</b>',
    )

    expect(root.querySelector('a, img, h1, ul, li, pre, b, p, [src]')).toBeNull()
    expect(root).toHaveTextContent('Plan See the docs and a diagram. one two make raw')
    expect(root.querySelector('code')).toHaveTextContent('make')
  })

  it('makes links and bare URLs links, as a reply does, but not the URLs in its code', () => {
    const root = renderInline(
      'Read [the docs](https://example.com/docs), then https://example.com/status; ran `curl https://example.com/api`. ' +
        '[setup](docs/setup.md) [run](javascript:alert(1))',
    )

    expect(links(root)).toEqual([
      { text: 'the docs', href: 'https://example.com/docs' },
      { text: 'https://example.com/status', href: 'https://example.com/status' },
    ])
    expect(screen.getByText('curl https://example.com/api').tagName).toBe('CODE')
    expect(root).toHaveTextContent(
      'Read the docs, then https://example.com/status; ran curl https://example.com/api. setup run',
    )
  })
})

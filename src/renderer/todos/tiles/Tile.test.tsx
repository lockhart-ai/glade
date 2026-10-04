import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { faFileLines } from '@fortawesome/free-regular-svg-icons'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildKind } from '../../../shared/todoHub'
import type { ContextMenuTargetProps } from '../../context-menus'
import { NOW_REFRESH_MS } from '../../task-list/useNow'
import { HUB_NOW, minutesAgo } from '../test-hub'
import { Tile, type TileProps } from './Tile'
import styles from './Tile.module.css'

const here = dirname(fileURLToPath(import.meta.url))
const tileCss = readFileSync(join(here, 'Tile.module.css'), 'utf8')
const hubCss = readFileSync(join(here, '..', 'TodoHub.module.css'), 'utf8')

const FILE: TileProps = {
  kind: ChildKind.File,
  name: 'Rate limits reference',
  icon: faFileLines,
  tag: 'Markdown',
  at: minutesAgo(6),
}

function tile(): HTMLElement {
  return screen.getByRole('group')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Tile', () => {
  it('shows its icon, its title with its tag, and its age, and is named by its kind and title', () => {
    render(<Tile {...FILE} />)

    const shown = screen.getByRole('group', { name: 'File: Rate limits reference' })
    expect(shown).toHaveTextContent('Rate limits referenceMarkdown6m')
    expect(shown.querySelector('svg')).not.toBeNull()
    expect(within(shown).getByText('Markdown')).toHaveClass(styles.tag ?? '')
    // Its age says the exact time on hover, and its title is whole there when it's cut short.
    expect(within(shown).getByText('6m')).toHaveAttribute('title', 'Sep 23, 2026, 2:24 PM')
    expect(within(shown).getByText('6m')).toHaveAttribute('datetime', new Date(minutesAgo(6)).toISOString())
    expect(within(shown).getByTitle('Rate limits reference')).toBeInTheDocument()
    expect(shown).toHaveAttribute('data-kind', ChildKind.File)
  })

  it('takes the focus, so every child is reachable with Tab', () => {
    render(<Tile {...FILE} />)
    expect(tile()).toHaveAttribute('tabindex', '0')
    tile().focus()
    expect(tile()).toHaveFocus()
  })

  it('has no tag, lead or state, and nothing under its first line, unless given', () => {
    render(<Tile kind={ChildKind.Link} name="fix-501" icon={faFileLines} at={minutesAgo(0)} />)
    expect(tile()).toHaveTextContent(/^fix-501now$/)
    expect(tile().children).toHaveLength(1)
    expect(tile()).not.toHaveClass(styles.selected ?? '', styles.openable ?? '', styles.acting ?? '')
  })

  it('is never live: nothing marks it as running, whatever it is', () => {
    render(<Tile {...FILE} kind={ChildKind.Commit} state="+54 −0" />)
    expect(tile()).not.toHaveAttribute('data-live')
    expect(tile().className).not.toMatch(/live/)
    expect(tile().innerHTML).not.toMatch(/live/i)
  })

  it('shows a short code before its title, and where it stands before its age', () => {
    render(<Tile {...FILE} kind={ChildKind.Commit} name="Fix the header" tag={null} lead="0c4d2e1" state="+54 −0" />)
    expect(tile()).toHaveTextContent('0c4d2e1Fix the header+54 −0 · 6m')
    expect(screen.getByText('0c4d2e1')).toHaveClass(styles.lead ?? '')
  })

  it('is outlined when selected, e.g. the file the Files tab shows', () => {
    render(<Tile {...FILE} selected />)
    expect(tile()).toHaveClass(styles.selected ?? '')
  })

  it('shows something larger in its icon’s place, e.g. an image’s thumbnail', () => {
    render(<Tile {...FILE} media={<img alt="" src="data:image/png;base64,AA==" />} />)
    expect(tile().querySelector('img')).not.toBeNull()
    expect(tile().querySelector('svg')).toBeNull()
    expect(tile().querySelector('img')?.parentElement).toHaveClass(styles.media ?? '')
  })

  it('shows what it opens to under its first line, in line with its title', () => {
    render(
      <Tile {...FILE} kind={ChildKind.Commit}>
        <p>fix-501 · 3 files</p>
      </Tile>,
    )
    expect(tile().children).toHaveLength(2)
    expect(screen.getByText('fix-501 · 3 files').parentElement).toHaveClass(styles.body ?? '')
  })

  it('has nothing under its first line when given nothing, as a tile that opens and closes gives', () => {
    render(<Tile {...FILE}>{false}</Tile>)
    expect(tile().children).toHaveLength(1)
  })

  it('moves its age on by itself as time passes', () => {
    render(<Tile {...FILE} />)
    expect(screen.getByText('6m')).toBeInTheDocument()

    act(() => {
      vi.setSystemTime(HUB_NOW + 4 * 60_000)
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })

    expect(screen.getByText('10m')).toBeInTheDocument()
  })

  describe('one that opens', () => {
    it('opens on a click, and on ↵ or Space while it has the focus, and on no other key', () => {
      const onOpen = vi.fn()
      render(<Tile {...FILE} onOpen={onOpen} />)
      expect(tile()).toHaveClass(styles.openable ?? '')

      fireEvent.click(screen.getByText('Markdown'))
      expect(onOpen).toHaveBeenCalledTimes(1)
      fireEvent.keyDown(tile(), { key: 'Enter' })
      fireEvent.keyDown(tile(), { key: ' ' })
      expect(onOpen).toHaveBeenCalledTimes(3)
      fireEvent.keyDown(tile(), { key: 'ArrowDown' })
      fireEvent.keyDown(tile(), { key: 'a' })
      expect(onOpen).toHaveBeenCalledTimes(3)
    })

    it('leaves a click or a key on a control inside it to the control', () => {
      const onOpen = vi.fn()
      const onReveal = vi.fn()
      render(
        <Tile
          {...FILE}
          onOpen={onOpen}
          actions={
            <button type="button" onClick={onReveal}>
              <span>Reveal in folder</span>
            </button>
          }
        />,
      )
      expect(tile()).toHaveClass(styles.acting ?? '')

      fireEvent.click(screen.getByText('Reveal in folder'))
      fireEvent.keyDown(screen.getByRole('button', { name: 'Reveal in folder' }), { key: 'Enter' })

      expect(onReveal).toHaveBeenCalledTimes(1)
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('does nothing on a click or a key when it opens nothing', () => {
      render(<Tile {...FILE} />)
      fireEvent.click(tile())
      fireEvent.keyDown(tile(), { key: 'Enter' })
      expect(tile()).not.toHaveClass(styles.openable ?? '')
    })
  })

  describe('what a file’s and a link’s tile add (#498)', () => {
    /** A context menu's target, as `useContextMenu` makes one: ⇧F10 is its key. */
    function menuTarget(): ContextMenuTargetProps & { readonly opened: string[] } {
      const opened: string[] = []
      return {
        opened,
        onContextMenu: (event) => {
          event.preventDefault()
          opened.push('right-click')
        },
        onKeyDown: (event) => {
          if (event.key !== 'F10' || !event.shiftKey) return
          event.preventDefault()
          opened.push('key')
        },
      }
    }

    it('says more about its tag under the pointer, and nothing unless given', () => {
      const { rerender } = render(<Tile {...FILE} tagTitle="docs/rate-limits.md" />)
      expect(screen.getByText('Markdown')).toHaveAttribute('title', 'docs/rate-limits.md')
      rerender(<Tile {...FILE} />)
      expect(screen.getByText('Markdown')).not.toHaveAttribute('title')
    })

    it('fades back when muted, says it’s the current one when selected, and is busy while it’s worked out', () => {
      const { rerender } = render(<Tile {...FILE} />)
      expect(tile()).not.toHaveClass(styles.muted ?? '')
      expect(tile()).not.toHaveAttribute('aria-current')
      expect(tile()).not.toHaveAttribute('aria-busy')

      rerender(<Tile {...FILE} muted selected busy />)
      expect(tile()).toHaveClass(styles.muted ?? '')
      expect(tile()).toHaveAttribute('aria-current', 'true')
      expect(tile()).toHaveAttribute('aria-busy', 'true')
      // A muted tile's title and icon are as faint as the rest; nothing about it is pink.
      expect(tileCss).toMatch(/\.muted \.title \{\s*color: var\(--color-faint\)/)
      expect(tileCss).toMatch(/\.muted \.icon \{\s*opacity: 0\.6/)
    })

    it('hands out its own element', () => {
      const ref = createRef<HTMLDivElement>()
      render(<Tile {...FILE} ref={ref} />)
      expect(ref.current).toBe(tile())
    })

    it('opens its context menu on a right-click, and on ⇧F10 from itself or a control inside it', () => {
      const target = menuTarget()
      const onOpen = vi.fn()
      render(<Tile {...FILE} onOpen={onOpen} menuTarget={target} actions={<button type="button">More</button>} />)

      fireEvent.contextMenu(screen.getByText('Markdown'))
      fireEvent.keyDown(tile(), { key: 'F10', shiftKey: true })
      fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'F10', shiftKey: true })
      expect(target.opened).toEqual(['right-click', 'key', 'key'])
      // The menu's key is the menu's alone, and every other key is still the tile's.
      expect(onOpen).not.toHaveBeenCalled()
      fireEvent.keyDown(tile(), { key: 'Enter' })
      expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it('has its menu though it opens nothing, as a file that’s gone has', () => {
      const target = menuTarget()
      render(<Tile {...FILE} menuTarget={target} />)

      fireEvent.keyDown(tile(), { key: 'Enter' })
      fireEvent.keyDown(tile(), { key: ' ' })
      fireEvent.click(tile())
      expect(target.opened).toEqual([])
      fireEvent.keyDown(tile(), { key: 'F10', shiftKey: true })
      fireEvent.contextMenu(tile())
      expect(target.opened).toEqual(['key', 'right-click'])
      expect(tile()).not.toHaveClass(styles.openable ?? '')
    })

    it('has no menu unless given one', () => {
      render(<Tile {...FILE} />)
      // Nothing stops the right-click: it's the window's own.
      expect(fireEvent.contextMenu(tile())).toBe(true)
    })

    it('keeps its actions in its age’s place while they’re pinned, e.g. while its menu is open, and only if it has some', () => {
      const { rerender } = render(<Tile {...FILE} actions={<button type="button">More</button>} />)
      expect(tile()).not.toHaveClass(styles.pinned ?? '')
      rerender(<Tile {...FILE} actions={<button type="button">More</button>} actionsPinned />)
      expect(tile()).toHaveClass(styles.pinned ?? '')
      rerender(<Tile {...FILE} actionsPinned />)
      expect(tile()).not.toHaveClass(styles.pinned ?? '')
    })

    it('shows its icon buttons in its age’s place under the pointer, with the focus and while pinned, 22px square, never on black', () => {
      expect(tileCss).toMatch(
        /\.acting:hover \.actions,\s*\.acting:focus-within \.actions,\s*\.pinned \.actions \{\s*display: flex/,
      )
      expect(tileCss).toMatch(
        /\.acting:hover \.right,\s*\.acting:focus-within \.right,\s*\.pinned \.right \{\s*display: none/,
      )
      expect(tileCss).toMatch(/\.actions \.action \{\s*width: 22px;\s*height: 22px/)
      expect(tileCss).toMatch(/\.actions \.action:hover:enabled \{\s*background: var\(--color-inner-2\)/)
    })
  })
})

describe('the hub’s colours', () => {
  it('has nothing black inside a card: no tile, pill or card is on the window’s or the panel’s background', () => {
    for (const css of [tileCss, hubCss]) {
      expect(css).not.toMatch(/background(-color)?:\s*var\(--color-(bg|panel)\)/)
      expect(css).not.toMatch(/background(-color)?:\s*(#0|#1|black)/i)
    }
  })

  it('puts a tile on inner with an inner-border outline, and the selected pill on strong', () => {
    expect(tileCss).toMatch(
      /\.tile \{[^}]*background: var\(--color-inner\);[^}]*border: 1px solid var\(--color-inner-border\)/,
    )
    expect(hubCss).toMatch(/\.card \{[^}]*background: var\(--color-inner-2\)/)
    expect(hubCss).toMatch(/\.pill\.on \{[^}]*background: var\(--color-strong\)/)
  })

  it('uses pink only for a commit’s removed lines', () => {
    const pink = [...tileCss.matchAll(/([^{}]+)\{[^}]*var\(--color-pink\)/g)].map((match) => match[1]?.trim())
    expect(pink).toEqual([expect.stringContaining('.removed')])
    expect(hubCss).not.toContain('--color-pink')
  })

  it('has nothing live: no live tint on a tile, and no blue count or pill', () => {
    for (const css of [tileCss, hubCss]) {
      expect(css).not.toMatch(/\.live\b/)
      expect(css).not.toMatch(/var\(--color-live/)
    }
    // Blue is left to the focus ring, a commit's hash, a todo's status line and the progress bar.
    const blue = (css: string): (string | undefined)[] =>
      [...css.matchAll(/([^{}]+)\{[^}]*var\(--color-blue(-text)?\)/g)].map((match) =>
        match[1]?.replace(/\/\*[^]*?\*\//g, '').trim(),
      )
    expect(blue(tileCss)).toEqual(['.tile:focus-visible', '.lead'])
    for (const selector of blue(hubCss)) expect(selector).not.toMatch(/\.(count|pill)(?!:focus-visible)/)
  })
})

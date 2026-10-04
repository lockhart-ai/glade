import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { faFileLines } from '@fortawesome/free-regular-svg-icons'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildKind } from '../../../shared/todoHub'
import { NOW_REFRESH_MS } from '../../task-list/useNow'
import { HUB_NOW, minutesAgo } from '../test-hub'
import { Tile, TileLine, TileTone, type TileProps } from './Tile'
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

  it('has no tag, lead, state or lines of its own unless given', () => {
    render(<Tile kind={ChildKind.Subagent} name="fix-501" icon={faFileLines} at={minutesAgo(0)} />)
    expect(tile()).toHaveTextContent(/^fix-501now$/)
    expect(tile().children).toHaveLength(1)
    expect(tile()).not.toHaveAttribute('data-live')
    expect(tile()).not.toHaveClass(styles.live ?? '', styles.selected ?? '', styles.openable ?? '', styles.acting ?? '')
  })

  it('shows a short code before its title, and where it stands before its age', () => {
    render(<Tile {...FILE} kind={ChildKind.Commit} name="Fix the header" tag={null} lead="0c4d2e1" state="+54 −0" />)
    expect(tile()).toHaveTextContent('0c4d2e1Fix the header+54 −0 · 6m')
    expect(screen.getByText('0c4d2e1')).toHaveClass(styles.lead ?? '')
  })

  it('is on the live tint while it runs, with its state and its age in blue', () => {
    render(<Tile {...FILE} kind={ChildKind.Subagent} state="Running" tone={TileTone.Live} live />)
    expect(tile()).toHaveClass(styles.live ?? '')
    expect(tile()).toHaveAttribute('data-live')
    expect(screen.getByText('Running').parentElement).toHaveClass(styles.liveText ?? '')
    expect(screen.getByText('Running')).not.toHaveClass(styles.failed ?? '')
  })

  it('says what itself failed in pink, and its age stays grey', () => {
    render(<Tile {...FILE} kind={ChildKind.Watcher} state="Failed" tone={TileTone.Failed} />)
    expect(screen.getByText('Failed')).toHaveClass(styles.failed ?? '')
    expect(screen.getByText('Failed').parentElement).not.toHaveClass(styles.liveText ?? '')
    expect(screen.getByText('6m')).not.toHaveClass(styles.failed ?? '')
    expect(tile()).not.toHaveClass(styles.live ?? '')
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

  it('shows its own lines under its first, each with its label, and what failed in pink', () => {
    render(
      <Tile {...FILE} kind={ChildKind.Watcher}>
        <TileLine label="last">lint pass 38s</TileLine>
        <TileLine label="end" failed>
          failed with exit code 1
        </TileLine>
        <TileLine>Rerunning the burst test</TileLine>
      </Tile>,
    )
    expect(tile().children).toHaveLength(2)
    expect(screen.getByText('last')).toHaveClass(styles.lineLabel ?? '')
    expect(screen.getByText('lint pass 38s')).not.toHaveClass(styles.failed ?? '')
    expect(screen.getByText('failed with exit code 1')).toHaveClass(styles.failed ?? '')
    expect(screen.getByText('Rerunning the burst test').parentElement?.children).toHaveLength(1)
  })

  it('has no lines when given none, as a tile whose line comes and goes gives', () => {
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
})

describe('the hub’s colours', () => {
  it('has nothing black inside a card: no tile, pill or card is on the window’s or the panel’s background', () => {
    for (const css of [tileCss, hubCss]) {
      expect(css).not.toMatch(/background(-color)?:\s*var\(--color-(bg|panel)\)/)
      expect(css).not.toMatch(/background(-color)?:\s*(#0|#1|black)/i)
    }
  })

  it('puts a tile on inner with an inner-border outline, a live one on the live tint, and the selected pill on strong', () => {
    expect(tileCss).toMatch(
      /\.tile \{[^}]*background: var\(--color-inner\);[^}]*border: 1px solid var\(--color-inner-border\)/,
    )
    expect(tileCss).toMatch(
      /\.tile\.live:hover \{[^}]*background: var\(--color-live\);[^}]*border-color: var\(--color-live-border\)/,
    )
    expect(hubCss).toMatch(/\.card \{[^}]*background: var\(--color-inner-2\)/)
    expect(hubCss).toMatch(/\.pill\.on \{[^}]*background: var\(--color-strong\)/)
  })

  it('uses pink only for what failed and for removed lines, and blue only for what’s live, a commit’s hash and a status line', () => {
    const pink = [...tileCss.matchAll(/([^{}]+)\{[^}]*var\(--color-pink\)/g)].map((match) => match[1]?.trim())
    expect(pink).toEqual(['.failed', expect.stringContaining('.removed')])
    expect(hubCss).not.toContain('--color-pink')
  })
})

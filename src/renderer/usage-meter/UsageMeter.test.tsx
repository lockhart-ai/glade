import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLevel, UsageLimitKind, type Account, type AccountStatus, type UsageReading } from '../../shared/account'
import { EventType } from '../../shared/bridge'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, type FakeBridge } from '../store/test-bridge'
import { UsageDetails, UsageMeter } from '.'

/** Sep 27, 2026, 12:00 local time: "now" for these tests. */
const NOW = new Date(2026, 8, 27, 12, 0).getTime()
const MINUTE = 60_000

const LOGIN: Account = {
  email: 'sam@acme.dev',
  organization: null,
  subscriptionType: 'Claude Max',
  tokenSource: null,
  apiKeySource: null,
  apiProvider: 'firstParty',
  readAt: NOW,
}

const SESSION: UsageReading = {
  limit: { kind: UsageLimitKind.Session },
  utilization: 0.38,
  resetsAt: new Date(2026, 8, 27, 15, 40).getTime(),
  level: UsageLevel.Within,
  readAt: NOW - 2 * MINUTE,
}
const WEEK: UsageReading = {
  limit: { kind: UsageLimitKind.Weekly },
  utilization: 0.22,
  resetsAt: new Date(2026, 9, 1, 9, 0).getTime(),
  level: UsageLevel.Within,
  readAt: NOW - 2 * MINUTE,
}
const OPUS: UsageReading = { ...WEEK, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }, utilization: 0.09 }
const EXTRA: UsageReading = { ...WEEK, limit: { kind: UsageLimitKind.ExtraUsage }, utilization: 0.12, resetsAt: null }

async function renderMeter(accountStatus: AccountStatus): Promise<FakeBridge> {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [], accountStatus })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <UsageMeter />
    </GladeStoreProvider>,
  )
  return fake
}

function row(): HTMLElement {
  return screen.getByRole('button', { name: 'Usage' })
}

/** The ring's arc, as the design draws it, or null for an empty ring. */
function arc(): string | null {
  return row().querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray') ?? null
}

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(row())
  await settleFloating()
  return screen.getByRole('dialog', { name: 'Usage' })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UsageMeter', () => {
  it('shows an empty ring, “within limits”, before anything is read', async () => {
    await renderMeter({ account: null, usage: [] })

    expect(row()).toHaveTextContent(/^Usagewithin limits$/)
    expect(row()).toHaveAttribute('data-state', 'unknown')
    expect(arc()).toBeNull()
  })

  it('shows the most-used limit in blue, with its percentage and reset time', async () => {
    await renderMeter({ account: LOGIN, usage: [SESSION, WEEK, OPUS] })

    expect(row()).toHaveTextContent(/^Session38%resets 15:40$/)
    expect(row()).toHaveAttribute('data-state', 'normal')
    // The design's ring: 38% of a 37.7-long circle.
    expect(arc()).toBe('14.3 37.7')
    expect(row().querySelectorAll('circle')[1]?.getAttribute('class')).not.toMatch(/near/)
  })

  it('turns purple from 70%', async () => {
    await renderMeter({ account: LOGIN, usage: [{ ...SESSION, utilization: 0.84, level: UsageLevel.Warning }, WEEK] })

    expect(row()).toHaveTextContent(/^Session84%resets 15:40$/)
    expect(row()).toHaveAttribute('data-state', 'warning')
    expect(row().className).toMatch(/warning/)
    expect(row().querySelectorAll('circle')[1]?.getAttribute('class')).toMatch(/near/)
  })

  it('takes the question card’s highlight at the limit, and says when it resets', async () => {
    await renderMeter({ account: LOGIN, usage: [{ ...SESSION, utilization: null, level: UsageLevel.Limited }, WEEK] })

    expect(row()).toHaveTextContent(/^Session limitResets at 15:40$/)
    expect(row()).toHaveAttribute('data-state', 'limited')
    expect(row().className).toMatch(/limited/)
    expect(arc()).toBe('37.7 37.7')
  })

  it('is hidden for an API key, which has no plan limits', async () => {
    await renderMeter({ account: { ...LOGIN, subscriptionType: null, apiKeySource: 'ANTHROPIC_API_KEY' }, usage: [] })

    expect(screen.queryByRole('button', { name: 'Usage' })).toBeNull()
  })

  it('follows what main says, and drops a limit when its window resets', async () => {
    const fake = await renderMeter({ account: LOGIN, usage: [] })
    const soon = { ...SESSION, utilization: 0.91, level: UsageLevel.Warning, resetsAt: NOW + MINUTE }

    act(() => {
      fake.emit({ type: EventType.AccountChanged, status: { account: LOGIN, usage: [soon, WEEK] } })
    })
    expect(row()).toHaveTextContent(/^Session91%/)

    // Main drops the reading at its reset; until then, the row stops showing it once it's past.
    await act(() => vi.advanceTimersByTimeAsync(MINUTE + 30_000))
    expect(row()).toHaveTextContent(/^This week22%resets Oct 1 09:00$/)
  })

  it('opens a popover over the row that lists every limit, with the plan and how old the reading is', async () => {
    await renderMeter({ account: LOGIN, usage: [SESSION, WEEK, OPUS] })

    const popover = await openPopover()
    expect(row()).toHaveAttribute('aria-expanded', 'true')
    expect(within(popover).getByText('Usage')).toBeInTheDocument()
    expect(within(popover).getByText('Claude Max')).toBeInTheDocument()
    expect(
      within(popover)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Session', 'This week', 'This week · Opus'])
    expect(within(popover).getByRole('group', { name: 'Session' })).toHaveTextContent('Session38%resets 15:40')
    expect(within(popover).getByRole('group', { name: 'This week · Opus' })).toHaveTextContent(
      'This week · Opus9%resets Oct 1 09:00',
    )
    expect(popover).toHaveTextContent('From Claude Code · updated 2 min ago')

    fireEvent.keyDown(popover, { key: 'Escape' })
    await settleFloating()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(row()).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggles its popover from the row', async () => {
    await renderMeter({ account: LOGIN, usage: [SESSION] })
    await openPopover()
    fireEvent.pointerDown(row())
    fireEvent.mouseDown(row())
    fireEvent.click(row())
    await settleFloating()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('UsageDetails', () => {
  it('says nothing is read yet, with no plan and no age, before Claude Code has said', () => {
    render(<UsageDetails plan={null} readings={[]} now={NOW} />)

    expect(screen.getByText('Claude Code says how much of your plan is used as tasks run.')).toBeInTheDocument()
    expect(screen.queryByText(/From Claude Code/)).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('shows extra usage with no reset time, and a limit near or at its end in purple', () => {
    render(
      <UsageDetails
        plan="Claude Max"
        readings={[
          { ...SESSION, utilization: null, level: UsageLevel.Limited },
          { ...WEEK, utilization: 0.84, level: UsageLevel.Warning },
          EXTRA,
        ]}
        now={NOW}
      />,
    )

    const session = screen.getByRole('group', { name: 'Session' })
    expect(session).toHaveTextContent('Sessionlimit reachedresets 15:40')
    expect(session.className).toMatch(/near/)
    expect(session.querySelector('[aria-hidden] > span')).toHaveStyle({ width: '100%' })
    expect(screen.getByRole('group', { name: 'This week' }).className).toMatch(/near/)
    const extra = screen.getByRole('group', { name: 'Extra usage' })
    expect(extra).toHaveTextContent(/^Extra usage12%$/)
    expect(extra.className).not.toMatch(/near/)
  })
})

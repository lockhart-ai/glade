import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageWindow, type Account, type AccountStatus } from '../../shared/account'
import { EventType } from '../../shared/bridge'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, type FakeBridge } from '../store/test-bridge'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'

/** Sep 26, 2026, 14:30 local time: "now" for these tests. */
const NOW = new Date(2026, 8, 26, 14, 30).getTime()

/** Read at 14:02 the same day. */
const READ_AT = new Date(2026, 8, 26, 14, 2).getTime()

const LOGIN: Account = {
  email: 'sam@acme.dev',
  organization: 'Acme Robotics',
  subscriptionType: 'Claude Max',
  tokenSource: null,
  apiKeySource: null,
  apiProvider: 'firstParty',
  readAt: READ_AT,
}

const NOTHING: AccountStatus = { account: null, usageWarning: null }

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

async function renderGeneral(accountStatus: AccountStatus): Promise<Rendered> {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [], accountStatus })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.General)
  })
  await settleFloating()
  return { ...fake, store }
}

/** The account block's rows, each as its name and value. */
function rows(): [string, string][] {
  const block = screen.getByRole('region', { name: 'Account' })
  return [...block.querySelectorAll('[title]')].map((value) => {
    const name = value.parentElement?.firstElementChild?.firstElementChild?.textContent ?? ''
    return [name, value.textContent]
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Settings › General', () => {
  it('shows the account a subscription login runs on: email, organization, plan and what it signed in with', async () => {
    await renderGeneral({ account: LOGIN, usageWarning: null })

    const block = screen.getByRole('region', { name: 'Account' })
    expect(within(block).getByRole('heading', { level: 3 })).toHaveTextContent('Account')
    expect(rows()).toEqual([
      ['Account', 'sam@acme.dev'],
      ['Organization', 'Acme Robotics'],
      ['Plan', 'Claude Max'],
      ['Signed in with', 'Claude Code login'],
    ])
    expect(within(block).getByText(/as Claude Code reports it/)).toBeInTheDocument()
    expect(within(block).getByText('Read from Claude Code at 14:02, when a task last started.')).toBeInTheDocument()
    // Nothing to change: Claude Code owns the login.
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
  })

  it('says it has nothing to show before any task has started', async () => {
    await renderGeneral(NOTHING)

    expect(screen.getByText(/Start a task to see it here/)).toBeInTheDocument()
    expect(rows()).toEqual([])
    expect(screen.queryByText(/Read from Claude Code/)).not.toBeInTheDocument()
  })

  it('says when Claude Code is not signed in, and how to sign in', async () => {
    await renderGeneral({
      account: { ...LOGIN, email: null, organization: null, subscriptionType: null, tokenSource: 'none' },
      usageWarning: null,
    })

    expect(rows()).toEqual([['Account', 'Not signed in']])
    expect(screen.getByText(/isn’t signed in, so tasks can’t run/)).toBeInTheDocument()
  })

  it('shows an API key, and where it came from', async () => {
    await renderGeneral({
      account: {
        ...LOGIN,
        email: null,
        organization: null,
        subscriptionType: null,
        tokenSource: 'claude.ai',
        apiKeySource: 'ANTHROPIC_API_KEY',
      },
      usageWarning: null,
    })

    expect(rows()).toEqual([
      ['Account', 'API key'],
      ['Plan', 'Pay as you go'],
      ['Signed in with', 'ANTHROPIC_API_KEY variable'],
    ])
  })

  it('follows the account as main reads it again, and the time with it', async () => {
    const { emit } = await renderGeneral(NOTHING)

    act(() => {
      emit({ type: EventType.AccountChanged, status: { account: LOGIN, usageWarning: null } })
    })
    expect(rows()[0]).toEqual(['Account', 'sam@acme.dev'])

    const yesterday = new Date(2026, 8, 25, 9, 5).getTime()
    act(() => {
      emit({
        type: EventType.AccountChanged,
        status: {
          account: { ...LOGIN, email: 'kim@acme.dev', readAt: yesterday },
          usageWarning: { utilization: 0.9, window: UsageWindow.Session, resetsAt: null },
        },
      })
    })
    expect(rows()[0]).toEqual(['Account', 'kim@acme.dev'])
    expect(screen.getByText('Read from Claude Code at Sep 25 09:05, when a task last started.')).toBeInTheDocument()
  })

  it('keeps a long email to one line, whole in its tooltip', async () => {
    const email = 'someone.with.a.very.long.address@a-subdomain.of.acme-robotics.example'
    await renderGeneral({ account: { ...LOGIN, email }, usageWarning: null })

    expect(screen.getByTitle(email)).toHaveTextContent(email)
  })
})

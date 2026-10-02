import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLevel, UsageLimitKind, type Account, type AccountStatus } from '../../shared/account'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { AgentErrorKind, TaskActivity, TaskErrorSource, type Task } from '../../shared/domain'
import { LoginState, type LoginStatus } from '../../shared/login'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
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

const NOTHING: AccountStatus = { account: null, usage: [] }

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

interface GeneralSetup {
  /** The tasks there are; none when left out. */
  readonly tasks?: Task[]
  /** Where logging in stands; idle when left out. */
  readonly login?: LoginStatus
  /** Where the fake main records the task each `login.start` named. */
  readonly loginStarts?: (string | null)[]
}

async function renderGeneral(
  accountStatus: AccountStatus,
  { tasks = [], login, loginStarts }: GeneralSetup = {},
): Promise<Rendered> {
  const fake = fakeBridge({
    workspaces: tasks.length === 0 ? [] : [sampleWorkspace('w1')],
    tasks,
    uiState: [],
    accountStatus,
    ...(login === undefined ? {} : { login }),
    ...(loginStarts === undefined ? {} : { loginStarts }),
  })
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
    await renderGeneral({ account: LOGIN, usage: [] })

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
      usage: [],
    })

    expect(rows()).toEqual([['Account', 'Not signed in']])
    expect(screen.getByText(/isn’t signed in, so tasks can’t run/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })

  describe('Log in', () => {
    const SIGNED_OUT: AccountStatus = {
      account: { ...LOGIN, email: null, organization: null, subscriptionType: null, tokenSource: 'none' },
      usage: [],
    }
    const loggedOutTask: Task = {
      ...sampleTask('t1', 'w1'),
      activity: TaskActivity.Error,
      error: {
        kind: AgentErrorKind.LoggedOut,
        source: TaskErrorSource.Api,
        status: null,
        code: 'authentication_failed',
        details: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        retries: 0,
        retryingMs: 0,
      },
    }

    it('isn’t offered while Claude Code is signed in and no task is logged out', async () => {
      await renderGeneral({ account: LOGIN, usage: [] })
      expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull()
    })

    it('is offered while a lost login stops a task, though Claude Code still names the account', async () => {
      await renderGeneral({ account: LOGIN, usage: [] }, { tasks: [loggedOutTask] })
      expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
      expect(screen.getByText('Opens Claude Code’s sign-in page in your browser.')).toBeInTheDocument()
    })

    it('runs the login for no task, waits on the browser, and cancels', async () => {
      const loginStarts: (string | null)[] = []
      const { invoke } = await renderGeneral(SIGNED_OUT, { loginStarts })

      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      expect(invoke).toHaveBeenLastCalledWith(CommandName.LoginStart, { taskId: null })
      expect(loginStarts).toEqual([null])
      expect(await screen.findByRole('button', { name: 'Waiting for the browser…' })).toBeDisabled()
      expect(screen.getByText('Finish logging in in your browser.')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(invoke).toHaveBeenLastCalledWith(CommandName.LoginCancel, {})
      expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
    })

    it('says when you’re logged in, and why logging in didn’t finish', async () => {
      const { emit } = await renderGeneral(SIGNED_OUT, { login: { state: LoginState.LoggedIn, at: NOW } })
      expect(screen.getByText(/You’re logged in\. Each task picks it up/)).toBeInTheDocument()

      act(() => {
        emit({ type: EventType.LoginChanged, status: { state: LoginState.Failed, message: 'Login failed: timed out' } })
      })
      expect(screen.getByText('Logging in didn’t finish: Login failed: timed out')).toBeInTheDocument()
    })

    it('says so when logging in, or cancelling it, couldn’t start', async () => {
      const { invoke } = await renderGeneral(SIGNED_OUT)

      invoke.mockRejectedValueOnce(bridgeError(BridgeErrorCode.Internal, 'No browser'))
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('No browser')

      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      await screen.findByRole('button', { name: 'Cancel' })
      expect(screen.queryByRole('alert')).toBeNull()
      invoke.mockRejectedValueOnce(bridgeError(BridgeErrorCode.Internal, 'Gone'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Gone')
    })
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
      usage: [],
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
      emit({ type: EventType.AccountChanged, status: { account: LOGIN, usage: [] } })
    })
    expect(rows()[0]).toEqual(['Account', 'sam@acme.dev'])

    const yesterday = new Date(2026, 8, 25, 9, 5).getTime()
    act(() => {
      emit({
        type: EventType.AccountChanged,
        status: {
          account: { ...LOGIN, email: 'kim@acme.dev', readAt: yesterday },
          usage: [
            {
              limit: { kind: UsageLimitKind.Session },
              utilization: 0.9,
              resetsAt: null,
              level: UsageLevel.Warning,
              readAt: 1,
            },
          ],
        },
      })
    })
    expect(rows()[0]).toEqual(['Account', 'kim@acme.dev'])
    expect(screen.getByText('Read from Claude Code at Sep 25 09:05, when a task last started.')).toBeInTheDocument()
  })

  it('keeps a long email to one line, whole in its tooltip', async () => {
    const email = 'someone.with.a.very.long.address@a-subdomain.of.acme-robotics.example'
    await renderGeneral({ account: { ...LOGIN, email }, usage: [] })

    expect(screen.getByTitle(email)).toHaveTextContent(email)
  })
})

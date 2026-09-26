import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, bridgeError, CommandName, EventType } from '../../shared/bridge'
import {
  EMPTY_MENU_BAR_SNAPSHOT,
  NeedsYouReason,
  type MenuBarSnapshot,
  type NeedsYouItem,
  type WorkingItem,
} from '../../shared/menuBar'
import { fakeBridge, refuse, sampleTask, type FakeBridge, type FakeMain } from '../store/test-bridge'
import { MENU_BAR_TICK_MS, MenuBarPage, POPOVER_BORDERS } from './MenuBarPage'
import { NOTHING_IN_FLIGHT } from './menuBarModel'
import { OPEN_GLADE, QUIT } from './MenuBarPopover'

const NOW = new Date('2026-09-25T12:00:00Z').getTime()

const ASKING: NeedsYouItem = {
  taskId: 't1',
  title: 'Add rate limiting to /search',
  workspaceId: 'w1',
  workspaceName: 'Acme API',
  reason: NeedsYouReason.Asking,
  since: NOW - 60_000,
}

const FAILED: NeedsYouItem = {
  taskId: 't2',
  title: 'Migrate the billing webhooks',
  workspaceId: 'w2',
  workspaceName: 'Billing',
  reason: NeedsYouReason.Error,
  since: NOW - 120_000,
}

const WORKING: WorkingItem = {
  taskId: 't3',
  title: 'Fix the flaky date test',
  workspaceId: 'w1',
  workspaceName: 'Acme API',
  status: 'Running the timezone tests',
  todos: { done: 3, total: 7, doing: ['Run the tests'] },
  pause: null,
  startedAt: NOW - 40_000,
}

const FULL: MenuBarSnapshot = {
  needsYou: [ASKING, FAILED],
  working: [WORKING],
  recent: [
    { seq: 1, taskId: 't1', title: 'Add rate limiting to /search', body: 'Which limit?', sentAt: NOW - 120_000 },
  ],
}

interface Rendered extends FakeBridge {
  readonly calls: string[]
}

async function renderPage(
  menuBar: MenuBarSnapshot | null = FULL,
  initial: Promise<MenuBarSnapshot> | null = null,
): Promise<Rendered> {
  const calls: string[] = []
  const main: FakeMain = {
    workspaces: [],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w2'), sampleTask('t3', 'w1')],
    uiState: [],
    ...(menuBar === null ? {} : { menuBar }),
    menuBarCalls: calls,
  }
  const fake = fakeBridge(main)
  const loaded = initial ?? fake.bridge.invoke(CommandName.MenuBarGet, {}).then(({ snapshot }) => snapshot)
  render(<MenuBarPage bridge={fake.bridge} initial={loaded} />)
  await act(async () => {
    await loaded.catch(() => undefined)
  })
  return { ...fake, calls }
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MenuBarPage', () => {
  it('lists what needs you, with where and why, what is working, and what was sent', async () => {
    await renderPage()

    const needs = section('Needs you')
    const rows = within(needs).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Add rate limiting to /searchAcme APIAsking a question',
      'Migrate the billing webhooksBillingStopped on an error',
    ])
    expect(within(needs).getByText('2')).toBeInTheDocument()
    expect(rows[1]?.querySelector('[data-state="error"]')).not.toBeNull()

    const working = within(section('Working')).getByRole('button')
    expect(working).toHaveTextContent('Fix the flaky date test')
    expect(working).toHaveTextContent('40s')
    expect(working).toHaveTextContent('Running the timezone tests')
    expect(within(working).getByRole('img', { name: '3 of 7 todos done · Now: Run the tests' })).toHaveTextContent(
      '3/7',
    )

    const recent = within(section('Recent')).getByRole('button')
    expect(recent).toHaveTextContent('Add rate limiting to /search2m agoWhich limit?')
    expect(screen.queryByText(NOTHING_IN_FLIGHT)).toBeNull()
  })

  it('says nothing is in flight when nothing is, and still offers Open Glade and Quit', async () => {
    await renderPage(EMPTY_MENU_BAR_SNAPSHOT)
    expect(screen.getByText(NOTHING_IN_FLIGHT)).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole('button', { name: OPEN_GLADE })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: QUIT })).toBeInTheDocument()
  })

  it('keeps up as main sends what changed: rows come, go and move on', async () => {
    const { emit } = await renderPage()

    act(() => {
      emit({ type: EventType.MenuBarChanged, snapshot: { ...FULL, needsYou: [FAILED], working: [] } })
    })
    expect(within(section('Needs you')).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Working' })).toBeNull()

    act(() => {
      emit({ type: EventType.MenuBarChanged, snapshot: EMPTY_MENU_BAR_SNAPSHOT })
    })
    expect(screen.getByText(NOTHING_IN_FLIGHT)).toBeInTheDocument()
  })

  it('ignores every other event', async () => {
    const { emit } = await renderPage()
    act(() => {
      emit({ type: EventType.TaskDeleted, taskId: 't1' })
    })
    expect(within(section('Needs you')).getAllByRole('button')).toHaveLength(2)
  })

  it('moves elapsed times and ages on while it is open', async () => {
    await renderPage()
    act(() => {
      vi.advanceTimersByTime(MENU_BAR_TICK_MS * 65)
    })
    expect(within(section('Working')).getByRole('button')).toHaveTextContent('1m 45s')
    expect(within(section('Recent')).getByRole('button')).toHaveTextContent('3m ago')
  })

  it('keeps a change main sent before what was there when it opened arrived', async () => {
    let resolve: (snapshot: MenuBarSnapshot) => void = () => undefined
    const initial = new Promise<MenuBarSnapshot>((done) => {
      resolve = done
    })
    const calls: string[] = []
    const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [], menuBarCalls: calls })
    render(<MenuBarPage bridge={fake.bridge} initial={initial} />)
    act(() => {
      fake.emit({ type: EventType.MenuBarChanged, snapshot: { ...EMPTY_MENU_BAR_SNAPSHOT, working: [WORKING] } })
    })
    await act(async () => {
      resolve(FULL)
      await initial
    })
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
    expect(section('Working')).toBeInTheDocument()
  })

  it('shows nothing in flight when what was in flight could not be read', async () => {
    await renderPage(null, refuse(bridgeError(BridgeErrorCode.Internal, 'no database')))
    expect(screen.getByText(NOTHING_IN_FLIGHT)).toBeInTheDocument()
  })

  it('stops listening once it goes, and a late answer changes nothing', async () => {
    let resolve: (snapshot: MenuBarSnapshot) => void = () => undefined
    const initial = new Promise<MenuBarSnapshot>((done) => {
      resolve = done
    })
    const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })
    const { unmount } = render(<MenuBarPage bridge={fake.bridge} initial={initial} />)
    expect(fake.listenerCount()).toBe(1)
    unmount()
    expect(fake.listenerCount()).toBe(0)
    await act(async () => {
      resolve(FULL)
      await initial
    })
  })

  it('stops listening once it goes, and a late failure changes nothing', async () => {
    let reject: (error: unknown) => void = () => undefined
    const initial = new Promise<MenuBarSnapshot>((_, fail) => {
      reject = fail
    })
    const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })
    const { unmount } = render(<MenuBarPage bridge={fake.bridge} initial={initial} />)
    unmount()
    await act(async () => {
      reject(new Error('gone'))
      await initial.catch(() => undefined)
    })
    expect(fake.listenerCount()).toBe(0)
  })
})

describe('acting on it', () => {
  it('opens the task of any row it is clicked on', async () => {
    const { calls } = await renderPage()
    const [, failed] = within(section('Needs you')).getAllByRole('button')
    if (failed === undefined) throw new Error('no second row')
    fireEvent.click(failed)
    fireEvent.click(within(section('Working')).getByRole('button'))
    fireEvent.click(within(section('Recent')).getByRole('button'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).toEqual(['openTask t2', 'openTask t3', 'openTask t1'])
  })

  it('shrugs off a row whose task went before it was clicked', async () => {
    const { calls, emit } = await renderPage()
    act(() => {
      emit({
        type: EventType.MenuBarChanged,
        snapshot: { ...EMPTY_MENU_BAR_SNAPSHOT, needsYou: [{ ...ASKING, taskId: 'gone' }] },
      })
    })
    fireEvent.click(within(section('Needs you')).getByRole('button'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).toEqual([])
  })

  it('opens Glade and quits from its footer', async () => {
    const { calls } = await renderPage()
    fireEvent.click(screen.getByRole('button', { name: OPEN_GLADE }))
    fireEvent.click(screen.getByRole('button', { name: QUIT }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).toEqual(['openGlade', 'quit'])
  })

  it('hides on Esc, and on no other key', async () => {
    const { calls } = await renderPage()
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).toEqual(['hide'])
  })

  it('asks for its window to be sized to what it lists, as that changes', async () => {
    const observers: { callback: ResizeObserverCallback; target: Element | null; disconnected: boolean }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly record: (typeof observers)[number]
        constructor(callback: ResizeObserverCallback) {
          this.record = { callback, target: null, disconnected: false }
          observers.push(this.record)
        }
        observe(target: Element): void {
          this.record.target = target
        }
        unobserve(): void {
          // Nothing's ever unobserved: the page disconnects.
        }
        disconnect(): void {
          this.record.disconnected = true
        }
      },
    )
    try {
      const { calls } = await renderPage()
      const [observer] = observers
      const target = observer?.target
      if (observer === undefined || !(target instanceof HTMLElement)) throw new Error('nothing observed')
      target.getBoundingClientRect = () => ({ height: 411.4 }) as DOMRect
      await act(async () => {
        observer.callback([], {} as ResizeObserver)
        await Promise.resolve()
      })
      expect(calls).toEqual([`fit ${String(412 + POPOVER_BORDERS)}`])
      expect(target).toContainElement(screen.getByRole('button', { name: QUIT }))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// A subagent's tile in the todo hub (#499; docs/design/html/48-todo-hub-tiles.html): it opens in place to its log, as
// its row in the Subagents tab does, and has the row's context menu.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../../shared/bridge'
import {
  PermissionRequestState,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type ToolCallEvent,
} from '../../../shared/domain'
import { ChildKind } from '../../../shared/todoHub'
import { refuse, samplePermissionRequest, type FakeHandlers, type FakeMain } from '../../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../../store/test-wrapper'
import { HUB_NOW, hubAgent, hubMain, minutesAgo, type HubTask } from '../test-hub'
import { ChildTile } from './ChildTile'
import partStyles from './TileParts.module.css'

interface TileStore extends StoreWrapper {
  readonly main: Partial<FakeMain>
}

/** A subagent's tile over a fake main with the hub on, hydrated; `more` is the fake main's other data. */
async function renderTile(
  task: HubTask,
  childKey: string,
  more: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<TileStore> {
  const main = { ...hubMain(task), stoppedSubagents: [], ...more }
  const wrapper = storeWrapper(main, overrides)
  await act(() => wrapper.store.getState().hydrate())
  render(<ChildTile taskId="t1" kind={ChildKind.Subagent} childKey={childKey} />, { wrapper: wrapper.wrapper })
  return { ...wrapper, main }
}

/** A call a subagent made, `minutes` ago. */
function did(
  id: string,
  parent: string,
  name: string,
  input: Record<string, unknown>,
  minutes = 1,
  fields: Partial<ToolCallEvent> = {},
): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.ToolCall,
    name,
    input,
    output: 'ok',
    state: ToolCallState.Done,
    finishedAt: minutesAgo(minutes),
    toolUseId: `use-${id}`,
    parentToolUseId: parent,
    progressSummary: null,
    ...fields,
  }
}

function said(id: string, parent: string, text: string, minutes = 2): NarrationEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.Narration,
    text,
    parentToolUseId: parent,
  }
}

/** The subagent in 48-todo-hub-tiles.html: running, with a note and three calls in its log. */
const SOAK = hubAgent('soak', 'soak-login', 4, { progressSummary: 'Running the login test 200 times' })
const SOAK_LOG = [
  said('soak-note', 'soak', 'The test can repeat now. Soaking the fix over 200 runs.', 3),
  did('soak-edit', 'soak', 'Edit', { file_path: '/code/w1/tests/conftest.py' }, 3),
  did('soak-commit', 'soak', 'Bash', { command: 'git commit -am "Let the login test repeat"' }, 2),
  did('soak-test', 'soak', 'Bash', { command: 'pytest tests/test_login.py --count 200 -x' }, 1, {
    state: ToolCallState.Running,
    output: null,
    finishedAt: null,
  }),
]

function tile(): HTMLElement {
  return screen.getByRole('group', { name: /^Subagent: / })
}

function log(name = 'soak-login'): HTMLElement {
  return screen.getByRole('log', { name: `${name} log` })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a subagent’s tile, opened', () => {
  it('opens in place to its log on a click, under what it’s doing now, and closes on the next', async () => {
    await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')
    expect(screen.queryByRole('log')).toBeNull()
    expect(tile().parentElement).not.toHaveAttribute('data-open')

    fireEvent.click(tile())

    expect(tile().parentElement).toHaveAttribute('data-open')
    expect(tile()).toHaveTextContent(/^soak-loginRunning · 1mRunning the login test 200 times/)
    // Its notes and its calls, in order, each call on one line with its argument relative to the workspace.
    expect(log()).toHaveTextContent('The test can repeat now. Soaking the fix over 200 runs.')
    expect(
      within(log())
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/^Edittests\/conftest\.py/),
      expect.stringMatching(/^Bashgit commit -am "Let the login test repeat"/),
      expect.stringMatching(/^Bashpytest tests\/test_login\.py --count 200 -x/),
    ])
    // In the tile's own box, not the Subagents tab's black one.
    expect(log()).toHaveClass(partStyles.well ?? '')

    fireEvent.click(tile())
    expect(tile().parentElement).not.toHaveAttribute('data-open')
  })

  it('opens and closes with ↵ and Space while it has the focus, and with no other key', async () => {
    await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')

    fireEvent.keyDown(tile(), { key: 'Enter' })
    expect(log()).toBeInTheDocument()
    fireEvent.keyDown(tile(), { key: 'a' })
    expect(tile().parentElement).toHaveAttribute('data-open')
    fireEvent.keyDown(tile(), { key: ' ' })
    expect(tile().parentElement).not.toHaveAttribute('data-open')
  })

  it('says nothing has happened yet for one that has done nothing', async () => {
    await renderTile({ toolEvents: [hubAgent('new', 'fresh-start', 0)] }, 'new')
    fireEvent.click(tile())
    expect(log('fresh-start')).toHaveTextContent(/^Nothing yet\.$/)
  })

  it('keeps a click inside its log for the log: a call opens its output, and the tile stays open', async () => {
    await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')
    fireEvent.click(tile())

    fireEvent.click(within(log()).getByRole('button', { name: /git commit/ }))
    expect(within(log()).getByRole('button', { name: /git commit/ })).toHaveAttribute('aria-expanded', 'true')
    expect(log()).toHaveTextContent('ok')
    // A click on a note, or on the box itself, is no click on the tile either.
    fireEvent.click(screen.getByText('The test can repeat now. Soaking the fix over 200 runs.'))
    fireEvent.click(log())

    expect(tile().parentElement).toHaveAttribute('data-open')
  })

  it('follows its subagent live while it’s open: each call as it’s made, and its result', async () => {
    const { fake } = await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')
    fireEvent.click(tile())
    expect(within(log()).getAllByRole('button')).toHaveLength(3)

    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: did('soak-read', 'soak', 'Read', { file_path: '/code/w1/tests/test_login.py' }, 0),
      })
    })
    expect(within(log()).getAllByRole('button')).toHaveLength(4)
    expect(log()).toHaveTextContent('Readtests/test_login.py')
    // Its tile is dated by the call, and still says what it's doing.
    expect(tile()).toHaveTextContent(/^soak-loginRunning · nowRunning the login test 200 times/)

    // It finishes: the summary goes, the tile turns grey, and the log stays open.
    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: {
          ...SOAK,
          state: ToolCallState.Done,
          output: '200 of 200 runs pass.',
          finishedAt: HUB_NOW,
          progressSummary: null,
        },
      })
    })
    expect(tile()).not.toHaveAttribute('data-live')
    expect(tile()).not.toHaveTextContent('Running the login test 200 times')
    expect(within(log()).getAllByRole('button')).toHaveLength(4)
  })

  it('goes live again when it’s woken after it finished, and its log takes up where it left off', async () => {
    const finished = hubAgent('soak', 'soak-login', 30, {
      state: ToolCallState.Done,
      output: '200 of 200 runs pass.',
      finishedAt: minutesAgo(20),
    })
    const { fake } = await renderTile({ toolEvents: [finished, ...SOAK_LOG] }, 'soak')
    expect(tile()).toHaveTextContent(/^soak-loginDone · 1m$/)
    fireEvent.click(tile())

    // A message wakes it: its call runs again, with a new summary, and it makes another call.
    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: {
          ...finished,
          state: ToolCallState.Running,
          output: null,
          finishedAt: null,
          progressSummary: 'Soaking again on the release branch',
        },
      })
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: did('soak-again', 'soak', 'Bash', { command: 'git switch release/2.5' }, 0),
      })
    })

    expect(tile()).toHaveAttribute('data-live')
    expect(tile()).toHaveTextContent(/^soak-loginRunning · nowSoaking again on the release branch/)
    expect(within(log()).getAllByRole('button')).toHaveLength(4)
    expect(log()).toHaveTextContent('Bashgit switch release/2.5')
  })

  it('nests a subagent of its own under the call that started it, and that one’s tile shows its own log', async () => {
    const inner = hubAgent('inner', 'check-flakes', 2, { parentToolUseId: 'soak' })
    const events = [SOAK, inner, did('inner-grep', 'inner', 'Grep', { pattern: 'flaky' }, 1)]
    const { wrapper } = await renderTile({ toolEvents: events }, 'soak')
    fireEvent.click(tile())
    expect(log()).toHaveTextContent('Agentcheck-flakes')
    expect(within(log()).getByRole('group', { name: 'Agent subagent calls' })).toHaveTextContent('Grepflaky')

    render(<ChildTile taskId="t1" kind={ChildKind.Subagent} childKey="inner" />, { wrapper })
    fireEvent.click(screen.getByRole('group', { name: 'Subagent: check-flakes' }))
    expect(log('check-flakes')).toHaveTextContent(/^Grepflaky/)
  })

  it('shows what was decided about a call’s permission on its row, as the Subagents tab does (#459)', async () => {
    const request = { ...samplePermissionRequest('p1', 't1'), toolUseId: 'use-soak-test', agentId: 'soak' }
    const { fake } = await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak', { permissionRequests: [request] })
    fireEvent.click(tile())
    expect(log().querySelector('[data-permission]')).toHaveTextContent(/Waiting on you/)

    act(() => {
      fake.emit({
        type: EventType.PermissionAnswered,
        permissionRequest: { ...request, state: PermissionRequestState.Allowed, closedAt: HUB_NOW },
      })
    })
    expect(log().querySelector('[data-permission]')).toHaveTextContent(/Allowed once/)
  })

  it('shows nothing of a log whose subagent the tool log no longer has', async () => {
    const { store } = await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')
    fireEvent.click(tile())

    act(() => {
      store.setState({ toolEvents: {} })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByRole('log')).toBeNull()
  })
})

describe('a subagent’s tile’s context menu', () => {
  async function open(): Promise<(string | null)[]> {
    fireEvent.contextMenu(tile())
    await act(() => Promise.resolve())
    return screen.getAllByRole('menuitem').map((item) => item.textContent)
  }

  async function choose(label: string): Promise<void> {
    await open()
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    await act(() => Promise.resolve())
  }

  it('is its row’s in the Subagents tab: it opens and closes its log, copies it, and stops it while it runs', async () => {
    const { main } = await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')

    expect(await open()).toEqual(['Expand log↵', 'Copy log', 'Stop subagent'])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Expand log/ }))
    expect(log()).toBeInTheDocument()
    // Choosing from the menu is no click on the tile: its log stays as the menu left it.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(await open()).toContain('Collapse log↵')
    fireEvent.click(screen.getByRole('menuitem', { name: /^Collapse log/ }))
    expect(tile().parentElement).not.toHaveAttribute('data-open')

    await choose('Copy log')
    expect(main.copied).toEqual([
      'soak-login\n' +
        'The test can repeat now. Soaking the fix over 200 runs.\n' +
        'Edit tests/conftest.py\n  ok\n' +
        'Bash git commit -am "Let the login test repeat"\n  ok\n' +
        'Bash pytest tests/test_login.py --count 200 -x\n  Running…',
    ])

    await choose('Stop subagent')
    expect(main.stoppedSubagents).toEqual(['soak'])
  })

  it('opens with ⇧F10 while the tile has the focus', async () => {
    await renderTile({ toolEvents: [SOAK] }, 'soak')
    fireEvent.keyDown(tile(), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(screen.getByRole('menu', { name: 'Subagent actions' })).toBeInTheDocument()
  })

  it('can’t stop one that has finished', async () => {
    const done = hubAgent('soak', 'soak-login', 9, { state: ToolCallState.Done, output: 'Done.', finishedAt: HUB_NOW })
    await renderTile({ toolEvents: [done] }, 'soak')
    expect(await open()).toEqual(['Expand log↵', 'Copy log'])
  })

  it('shows a toast when the subagent can’t be stopped', async () => {
    await renderTile(
      { toolEvents: [SOAK] },
      'soak',
      {},
      {
        [CommandName.SubagentsStop]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, "The subagent isn't running")),
      },
    )
    await choose('Stop subagent')
    expect(await screen.findByText("The subagent isn't running")).toBeInTheDocument()
  })

  it('leaves a call in its open log its own menu, and choosing from it keeps the tile open', async () => {
    const { main } = await renderTile({ toolEvents: [SOAK, ...SOAK_LOG] }, 'soak')
    fireEvent.click(tile())

    const row = within(log()).getByRole('button', { name: /git commit/ }).parentElement
    fireEvent.contextMenu(row ?? log())
    await act(() => Promise.resolve())
    expect(screen.getByRole('menu', { name: 'Tool call actions' })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Subagent actions' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy command' }))
    await act(() => Promise.resolve())
    expect(main.copied).toEqual(['git commit -am "Let the login test repeat"'])
    expect(tile().parentElement).toHaveAttribute('data-open')
  })
})

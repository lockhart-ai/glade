// The Agents tab (P16, #536): a tab for every agent in the task, each showing that agent's tool calls. On the fake
// main with the todo hub's hidden switch on.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import {
  TaskActivity,
  TodoState,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type ToolCallEvent,
} from '../../shared/domain'
import { SECONDS_REFRESH_MS } from './useElapsedNow'
import { NOW_REFRESH_MS } from '../task-list/useNow'
import { activePanelTab, PanelTab } from '../right-panel/panelModel'
import { storeWrapper } from '../store/test-wrapper'
import { sampleTask } from '../store/test-bridge'
import {
  HUB_NOW,
  hubAgent,
  hubFiling,
  hubMain,
  hubStore,
  hubTodo,
  minutesAgo,
  refOf,
  type HubStore,
  type HubTask,
} from '../todos/test-hub'
import { AgentsTab } from './AgentsTab'
import styles from './AgentsTab.module.css'

const MINUTE = 60_000

function call(id: string, minutes: number, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: `event-${id}`,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.ToolCall,
    name: 'Bash',
    input: { command: `pytest tests/${id}.py` },
    output: '..............\n14 passed',
    state: ToolCallState.Done,
    finishedAt: minutesAgo(minutes),
    toolUseId: id,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

function note(id: string, text: string, parentToolUseId: string | null = null): NarrationEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(30),
    kind: ToolEventKind.Narration,
    text,
    parentToolUseId,
  }
}

const finished = (minutes: number, output: string): Partial<ToolCallEvent> => ({
  state: ToolCallState.Done,
  output,
  finishedAt: minutesAgo(minutes),
})

/** The screens' task: Main, two subagents running and one finished, each started for a todo. */
const FIX = hubAgent('fix-501', 'fix-501', 30, finished(2, 'Opened PR #511.\nThe burst test covers it.'))
const DOCS = hubAgent('docs-503', 'docs-503', 29)
const LIMITS = hubAgent('limits-502', 'limits-502', 6)
const TODOS = [
  hubTodo('1', '#501 Return Retry-After on 429s'),
  hubTodo('2', '#502 Per-key limits for /search'),
  hubTodo('3', '#503 Document the rate limits', TodoState.Todo),
]
const SHIP: HubTask = {
  todos: TODOS,
  toolEvents: [
    note('n-main', 'Three issues, so three subagents, one for each todo.'),
    call('main-read', 30, { name: 'Read', input: { file_path: 'CHANGELOG.md' }, output: 'a\nb\nc' }),
    FIX,
    note('n-fix', 'The header goes in throttle.py.', 'fix-501'),
    call('test_throttle', 20, { parentToolUseId: 'fix-501' }),
    DOCS,
    LIMITS,
    call('test_search', 3, { parentToolUseId: 'limits-502', state: ToolCallState.Running, output: null }),
  ],
  filings: [
    hubFiling(refOf.subagent('fix-501'), '1'),
    hubFiling(refOf.subagent('limits-502'), '2'),
    hubFiling(refOf.subagent('docs-503'), '3'),
  ],
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(HUB_NOW)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

async function renderAgents(task: HubTask = SHIP, agentTabs: Record<string, string> = {}): Promise<HubStore> {
  const main = { ...hubMain(task), agentTabs }
  const hub: HubStore = { ...storeWrapper(main), main }
  await act(() => hub.store.getState().hydrate())
  render(<AgentsTab taskId="t1" rootPath="/Users/sample/code/api" />, { wrapper: hub.wrapper })
  // The task's filings, read as the tab shows it.
  await act(() => Promise.resolve())
  return hub
}

const strip = (): HTMLElement => screen.getByRole('tablist', { name: 'Agents' })
const tabs = (): HTMLElement[] => within(strip()).getAllByRole('tab')
/** An agent's tab, if it's in the strip: Main, an active subagent, or the temporary one that's finished and
 * selected. A finished subagent otherwise isn't a tab at all (#617): it's named in the caret's dropdown instead. */
const tabOrNull = (name: string): HTMLElement | null =>
  within(strip()).queryByRole('tab', { name: new RegExp(`${name}$`) })
const tab = (name: string): HTMLElement => {
  const found = tabOrNull(name)
  if (found === null) throw new Error(`No tab named “${name}”.`)
  return found
}
const shown = (): string | undefined => tabs().find((each) => each.getAttribute('aria-selected') === 'true')?.title
/** The caret that opens the finished subagents' dropdown, if any have finished. */
const caret = (): HTMLElement | null => screen.queryByRole('button', { name: /finished subagents$/ })
/** Opens the caret's dropdown and picks a finished subagent by name, showing it as the strip's temporary tab. */
async function pickFinished(name: string): Promise<void> {
  fireEvent.click(within(strip()).getByRole('button', { name: /finished subagents$/ }))
  await act(() => Promise.resolve())
  const menu = screen.getByRole('menu', { name: 'Finished subagents' })
  fireEvent.click(within(menu).getByRole('menuitem', { name }))
  await act(() => Promise.resolve())
}
const panel = (): HTMLElement => screen.getByRole('tabpanel')
const rows = (): string[] =>
  [...panel().querySelectorAll('[data-state]')]
    .filter((element) => element.hasAttribute('data-agent-call') || element.querySelector('button') !== null)
    .map((element) => element.textContent)
const line = (): HTMLElement | null => panel().querySelector('[data-agent-line]')
/** The todo's title on the line under the strip: the link to that todo. */
const todoLink = (): HTMLElement => within(panel()).getByRole('button', { name: /^#50\d / })
const setTab = (fake: HubStore['fake']): unknown[] =>
  fake.invoke.mock.calls.filter(([command]) => command === CommandName.AgentsSetTab).map(([, request]) => request)

describe('the strip', () => {
  it('has a tab for Main and every active subagent, the newest first, with a caret for the finished', async () => {
    await renderAgents()

    // fix-501 has finished and started no watcher: it's named in the caret's dropdown, not a tab.
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'limits-502', 'docs-503'])
    expect(tabs().map((each) => each.hasAttribute('data-running'))).toEqual([false, true, true])
    // Main's dot has its own activity label, with no pin icon (#617); a subagent's dot says whether it's running or
    // finished. Main is still going (#579): the two subagents it started directly are still running.
    expect(within(tab('Main')).getByRole('img', { name: 'Working in the background' })).toBeInTheDocument()
    expect(tab('Main')).toHaveAttribute('data-active', '')
    expect(within(tab('limits-502')).getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(caret()).toHaveTextContent('1')
    expect(caret()).toHaveAttribute('aria-label', '1 finished subagents')
  })

  it('has no caret while nothing has finished', async () => {
    await renderAgents({ ...SHIP, toolEvents: (SHIP.toolEvents ?? []).filter((event) => event !== FIX) })

    expect(caret()).toBeNull()
  })

  it('starts on Main, which holds the one tab stop and labels the list', async () => {
    await renderAgents()

    expect(shown()).toBe('Main')
    expect(tabs().map((each) => each.tabIndex)).toEqual([0, -1, -1])
    expect(panel()).toHaveAttribute('aria-labelledby', tab('Main').id)
    expect(tab('Main')).toHaveAttribute('aria-controls', panel().id)
    expect(tab('limits-502')).not.toHaveAttribute('aria-controls')
  })

  it('is Main alone, with no caret, for a task whose agent started no subagent', async () => {
    await renderAgents({ toolEvents: [call('only', 4)] })

    expect(tabs().map((each) => each.title)).toEqual(['Main'])
    expect(caret()).toBeNull()
    expect(rows()).toEqual(['Bashpytest tests/only.py14:2614 passed'])
  })

  it('picks an active agent on click, at once, and remembers it for the task', async () => {
    const { fake, store } = await renderAgents()

    fireEvent.click(tab('docs-503'))

    expect(shown()).toBe('docs-503')
    expect(tabs().map((each) => each.tabIndex)).toEqual([-1, -1, 0])
    expect(panel()).toHaveAttribute('aria-labelledby', tab('docs-503').id)
    expect(store.getState().agentTabs).toEqual({ t1: 'docs-503' })
    expect(setTab(fake)).toEqual([{ taskId: 't1', agentId: 'docs-503' }])

    // The tab it's already on: nothing more to remember.
    fireEvent.click(tab('docs-503'))
    fireEvent.click(tab('Main'))
    expect(shown()).toBe('Main')
    expect(store.getState().agentTabs).toEqual({})
    expect(setTab(fake)).toEqual([
      { taskId: 't1', agentId: 'docs-503' },
      { taskId: 't1', agentId: null },
    ])
  })

  it('picks a finished agent from the caret’s dropdown, as a temporary tab after the active ones', async () => {
    const { fake, store } = await renderAgents()

    await pickFinished('fix-501')

    expect(shown()).toBe('fix-501')
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'limits-502', 'docs-503', 'fix-501'])
    expect(tab('fix-501')).toHaveAttribute('aria-selected', 'true')
    expect(within(tab('fix-501')).getByRole('img', { name: 'Finished' })).toBeInTheDocument()
    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })
    expect(setTab(fake)).toEqual([{ taskId: 't1', agentId: 'fix-501' }])

    // Main or an active subagent picked again: the temporary tab goes, back to the caret's list alone.
    fireEvent.click(tab('Main'))
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'limits-502', 'docs-503'])
    expect(caret()).toHaveTextContent('1')
  })

  it('keeps the temporary tab if the subagent it names finishes while it’s still selected', async () => {
    const { fake } = await renderAgents()
    fireEvent.click(tab('docs-503'))

    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...DOCS, ...finished(0, 'Opened PR #512.') } })
    })

    expect(shown()).toBe('docs-503')
    expect(tab('docs-503')).toHaveAttribute('aria-selected', 'true')
    expect(tab('docs-503')).not.toHaveAttribute('data-running')
    expect(within(tab('docs-503')).getByRole('img', { name: 'Finished' })).toBeInTheDocument()
    // It's no longer among the active ones that share the row: just the one temporary tab after them.
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'limits-502', 'docs-503'])
  })

  it('still shows the agent picked when main couldn’t remember it', async () => {
    const hub = await hubStore(SHIP)
    hub.fake.invoke.mockImplementation((command) =>
      command === CommandName.AgentsSetTab ? Promise.reject(new Error('disk full')) : Promise.resolve({} as never),
    )
    render(<AgentsTab taskId="t1" />, { wrapper: hub.wrapper })

    await act(async () => {
      fireEvent.click(tab('docs-503'))
      await Promise.resolve()
    })

    expect(shown()).toBe('docs-503')
  })

  describe('with the keyboard', () => {
    it('moves between agents with ← and →, wrapping at the ends, the focus going with the tab picked', async () => {
      await renderAgents()
      tab('Main').focus()

      fireEvent.keyDown(tab('Main'), { key: 'ArrowRight' })
      expect(shown()).toBe('limits-502')
      expect(tab('limits-502')).toHaveFocus()

      fireEvent.keyDown(tab('limits-502'), { key: 'ArrowLeft' })
      expect(shown()).toBe('Main')
      // fix-501 has finished, so it's not among the tabs the arrows reach: Left from Main wraps to the last active one.
      fireEvent.keyDown(tab('Main'), { key: 'ArrowLeft' })
      expect(shown()).toBe('docs-503')
      expect(tab('docs-503')).toHaveFocus()
      fireEvent.keyDown(tab('docs-503'), { key: 'ArrowRight' })
      expect(shown()).toBe('Main')
      expect(tab('Main')).toHaveFocus()
      expect(tabs().filter((each) => each.tabIndex === 0)).toEqual([tab('Main')])
    })

    it('leaves any other key, and an arrow held with a modifier, alone', async () => {
      await renderAgents()

      for (const init of [
        { key: 'ArrowDown' },
        { key: 'a' },
        { key: 'ArrowRight', altKey: true },
        { key: 'ArrowRight', metaKey: true },
        { key: 'ArrowLeft', ctrlKey: true },
        { key: 'ArrowLeft', shiftKey: true },
      ]) {
        expect(fireEvent.keyDown(tab('Main'), init)).toBe(true)
      }
      // An arrow from somewhere in the strip that isn't a tab does nothing either.
      fireEvent.keyDown(strip(), { key: 'ArrowRight' })

      expect(shown()).toBe('Main')
    })

    it('picks a tab with ↵ or Space, as a click does', async () => {
      await renderAgents()

      // A button's own: the browser turns the key into a click.
      expect(tab('docs-503').tagName).toBe('BUTTON')
      fireEvent.click(tab('docs-503'))
      expect(shown()).toBe('docs-503')
    })
  })
})

describe('an agent’s tool calls', () => {
  it('are Main’s as the Tool calls tab draws them, each subagent it started an Agent call', async () => {
    await renderAgents()

    expect(within(panel()).getByRole('log', { name: 'Tool log' })).toBeInTheDocument()
    expect(panel()).toHaveTextContent('Three issues, so three subagents, one for each todo.')
    expect(rows()).toEqual([
      'ReadCHANGELOG.md14:003 lines',
      'Agentfix-50114:00Done · 28m · Opened PR #511.',
      'Agentdocs-50314:01Running · 29m',
      'Agentlimits-50214:24Running · 6m',
    ])
    // Nothing a subagent did is in Main's list, and Main's line names the model it runs on, with no todo about it.
    expect(panel()).not.toHaveTextContent('test_throttle')
    expect(line()).toHaveTextContent(/^Sample 1$/)
    expect(line()).not.toHaveTextContent('Working on')
    // A running subagent's call is live: the running call's highlight.
    expect(panel().querySelector('[data-agent-call="docs-503"]')).toHaveAttribute('data-state', 'running')
    expect(panel().querySelector('[data-agent-call="fix-501"]')).toHaveAttribute('data-state', 'done')
  })

  it('open their output on click, but an Agent call goes to its subagent’s tab instead', async () => {
    const { fake } = await renderAgents()

    fireEvent.click(within(panel()).getByRole('button', { name: /Read/ }))
    expect(within(panel()).getByLabelText('Read output')).toHaveTextContent('a b c')

    const agentCall = within(panel()).getByRole('button', { name: /fix-501/ })
    expect(agentCall).not.toHaveAttribute('aria-expanded')
    fireEvent.click(agentCall)

    expect(shown()).toBe('fix-501')
    expect(setTab(fake)).toEqual([{ taskId: 't1', agentId: 'fix-501' }])
    expect(within(panel()).queryByLabelText('Agent output')).toBeNull()
  })

  it('are a subagent’s own, with the whole panel: its notes, and each call with its result under it', async () => {
    await renderAgents()

    await pickFinished('fix-501')

    expect(panel()).toHaveTextContent('The header goes in throttle.py.')
    expect(rows()).toEqual(['Bashpytest tests/test_throttle.py14:1014 passed'])
    expect(panel()).not.toHaveTextContent('CHANGELOG.md')
    fireEvent.click(within(panel()).getByRole('button', { name: /Bash/ }))
    expect(within(panel()).getByLabelText('Bash output')).toHaveTextContent('14 passed')

    fireEvent.click(tab('limits-502'))
    expect(rows()).toEqual(['Bashpytest tests/test_search.py14:27Running…'])
  })

  it('say so for an agent with no calls yet', async () => {
    await renderAgents()

    fireEvent.click(tab('docs-503'))

    expect(panel()).toHaveTextContent('No tool calls yet.')
    expect(within(panel()).queryByRole('log')).toBeNull()
  })

  it('show a subagent of a subagent as an Agent call in its parent’s list, with a tab of its own', async () => {
    const inner = hubAgent('inner', 'check-links', 4, { parentToolUseId: 'docs-503' })
    await renderAgents({
      ...SHIP,
      toolEvents: [...(SHIP.toolEvents ?? []), inner, call('test_links', 2, { parentToolUseId: 'inner' })],
    })
    // fix-501 has finished and started no watcher: it's in the caret's dropdown, not a tab.
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'check-links', 'limits-502', 'docs-503'])
    expect(caret()).toHaveTextContent('1')
    // Main's list has only the subagents Main started.
    expect(rows()).toHaveLength(4)

    fireEvent.click(tab('docs-503'))
    expect(rows()).toEqual(['Agentcheck-links14:26Running · 4m'])
    fireEvent.click(within(panel()).getByRole('button', { name: /check-links/ }))

    expect(shown()).toBe('check-links')
    expect(rows()).toEqual(['Bashpytest tests/test_links.py14:2814 passed'])
    // It named no todo of its own, so it works on the one its parent was started for (#495).
    expect(line()).toHaveTextContent(/^Working on #503 Document the rate limitsRunning · 4m$/)
  })

  it('grow as the agent showing works, and not as another does', async () => {
    const { fake } = await renderAgents()
    fireEvent.click(tab('limits-502'))
    const list = within(panel()).getByRole('log')

    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: call('test_keys', 0, { parentToolUseId: 'limits-502' }),
      })
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('main-late', 0) })
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('fix-late', 0, { parentToolUseId: 'fix-501' }) })
    })

    expect(rows()).toEqual([
      'Bashpytest tests/test_search.py14:27Running…',
      'Bashpytest tests/test_keys.py14:3014 passed',
    ])
    expect(within(panel()).getByRole('log')).toBe(list)
  })
})

describe('a subagent moving between the running and the finished', () => {
  it('moves its tab when it finishes, and back when it’s woken, the list showing staying as it was', async () => {
    const { fake } = await renderAgents()
    fireEvent.click(tab('docs-503'))
    fireEvent.click(tab('limits-502'))
    const list = within(panel()).getByRole('log')
    fireEvent.click(within(list).getByRole('button', { name: /Bash/ }))
    const output = within(list).getByLabelText('Bash output')

    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...LIMITS, ...finished(0, 'Opened PR #513.') } })
    })
    // It finished while selected: it keeps its tab, now the temporary one after the active ones (#617); fix-501,
    // finished since before and never selected, stays off the strip, in the caret's dropdown.
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'docs-503', 'limits-502'])
    expect(tab('limits-502')).not.toHaveAttribute('data-running')
    expect(shown()).toBe('limits-502')
    // The list is the one it was, with the call you opened still open.
    expect(within(panel()).getByRole('log')).toBe(list)
    expect(within(list).getByLabelText('Bash output')).toBe(output)

    // Woken after it finished (#395): its call runs again, so it rejoins the active ones; the temporary tab, still
    // selected, stays last.
    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...FIX, state: ToolCallState.Running, output: null } })
    })
    expect(tabs().map((each) => each.title)).toEqual(['Main', 'docs-503', 'fix-501', 'limits-502'])
    expect(tab('fix-501')).toHaveAttribute('data-running')
    expect(shown()).toBe('limits-502')
    expect(within(panel()).getByRole('log')).toBe(list)
  })

  it('adds a subagent’s tab when it starts, first among the running, leaving the tab showing', async () => {
    const { fake } = await renderAgents()
    await pickFinished('fix-501')

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: hubAgent('notes-25', 'notes-25', 0) })
    })

    expect(tabs().map((each) => each.title)).toEqual(['Main', 'notes-25', 'limits-502', 'docs-503', 'fix-501'])
    expect(shown()).toBe('fix-501')
  })
})

describe('the line under the strip, on a subagent’s tab', () => {
  it('names the todo it’s working on, with its state, while it runs', async () => {
    await renderAgents()

    fireEvent.click(tab('limits-502'))

    expect(line()).toHaveTextContent(/^Working on #502 Per-key limits for \/searchRunning · 6m$/)
    expect(todoLink()).toHaveTextContent('#502 Per-key limits for /search')
  })

  it('says what it worked on, and how long it ran, once it has finished', async () => {
    await renderAgents()

    await pickFinished('fix-501')

    expect(line()).toHaveTextContent(/^Worked on #501 Return Retry-After on 429sDone · 28m$/)
  })

  it('goes to that todo in the Todos tab when its title is clicked', async () => {
    const { store } = await renderAgents()
    await pickFinished('fix-501')

    fireEvent.click(todoLink())

    expect(store.getState().todoFocus).toEqual({ taskId: 't1', todoId: '1', request: 1 })
    expect(activePanelTab(store.getState().uiState, 't1')).toBe(PanelTab.Todos)
    // Asked again, it's a new request.
    fireEvent.click(todoLink())
    expect(store.getState().todoFocus?.request).toBe(2)
  })

  it('isn’t there for a subagent with no todo, nor for one whose todo was deleted', async () => {
    const { fake } = await renderAgents({ ...SHIP, filings: [hubFiling(refOf.subagent('fix-501'), '1')] })
    fireEvent.click(tab('docs-503'))
    expect(line()).toBeNull()

    await pickFinished('fix-501')
    expect(line()).not.toBeNull()
    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: { items: TODOS.slice(1), updatedAt: HUB_NOW },
      })
    })
    expect(line()).toBeNull()
    expect(rows()).toHaveLength(1)
  })

  it('shows once the subagent is filed under a todo, and names the todo it’s moved to', async () => {
    const { fake } = await renderAgents({ ...SHIP, filings: [] })
    fireEvent.click(tab('docs-503'))
    expect(line()).toBeNull()

    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.subagent('docs-503'), '3')],
        removed: [],
      })
    })
    expect(line()).toHaveTextContent(/^Working on #503 Document the rate limitsRunning · 29m$/)

    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.subagent('docs-503'), '2')],
        removed: [],
      })
    })
    expect(line()).toHaveTextContent(/^Working on #502 Per-key limits/)
  })

  it('has no line when the task’s filings can’t be read', async () => {
    const hub = await hubStore(SHIP)
    const answer = hub.fake.invoke.getMockImplementation()
    hub.fake.invoke.mockImplementation((command, request) =>
      command === CommandName.TodoHubGet
        ? Promise.reject(new Error('unreadable'))
        : (answer?.(command, request) ?? Promise.resolve({} as never)),
    )
    render(<AgentsTab taskId="t1" />, { wrapper: hub.wrapper })
    await act(() => Promise.resolve())

    await pickFinished('fix-501')

    expect(line()).toBeNull()
    expect(rows()).toHaveLength(1)
  })
})

describe('times that tick', () => {
  it('count a subagent’s seconds through its first minute, then its minutes', async () => {
    const fresh = hubAgent('fresh', 'fresh', 0, { createdAt: HUB_NOW - 57_000 })
    await renderAgents({
      todos: TODOS,
      toolEvents: [fresh],
      filings: [hubFiling(refOf.subagent('fresh'), '1')],
    })
    expect(rows()).toEqual(['Agentfresh14:29Running · 57s'])

    act(() => {
      vi.advanceTimersByTime(SECONDS_REFRESH_MS)
    })
    expect(rows()).toEqual(['Agentfresh14:29Running · 58s'])
    act(() => {
      vi.advanceTimersByTime(2 * SECONDS_REFRESH_MS)
    })
    expect(rows()).toEqual(['Agentfresh14:29Running · 1m'])

    // From then on it reads in minutes, and is looked at again as often as other ages are.
    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS - SECONDS_REFRESH_MS)
    })
    expect(rows()).toEqual(['Agentfresh14:29Running · 1m'])
    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS + SECONDS_REFRESH_MS)
    })
    expect(rows()).toEqual(['Agentfresh14:29Running · 2m'])

    fireEvent.click(tab('fresh'))
    expect(line()).toHaveTextContent(/Running · 2m$/)
    act(() => {
      vi.advanceTimersByTime(2 * NOW_REFRESH_MS)
    })
    expect(line()).toHaveTextContent(/Running · 3m$/)
  })

  it('stop once the subagent has finished', async () => {
    const { fake } = await renderAgents()
    fireEvent.click(tab('limits-502'))
    expect(line()).toHaveTextContent(/Running · 6m$/)

    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...LIMITS, ...finished(0, 'Opened PR #513.') } })
    })
    expect(line()).toHaveTextContent(/^Worked on #502 Per-key limits for \/searchDone · 6m$/)
    act(() => {
      vi.advanceTimersByTime(10 * MINUTE)
    })
    expect(line()).toHaveTextContent(/Done · 6m$/)
  })
})

describe('which agent a task is on', () => {
  it('is the one it was left on, read with the task’s logs', async () => {
    const { fake } = await renderAgents(SHIP, { t1: 'fix-501' })

    expect(shown()).toBe('fix-501')
    expect(line()).toHaveTextContent(/^Worked on #501/)
    expect(setTab(fake)).toEqual([])
  })

  it('falls back to Main for an agent that’s gone, and comes back to it if it shows up', async () => {
    const { fake, store } = await renderAgents(SHIP, { t1: 'notes-25' })

    expect(shown()).toBe('Main')
    expect(store.getState().agentTabs).toEqual({ t1: 'notes-25' })

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: hubAgent('notes-25', 'notes-25', 0) })
    })
    expect(shown()).toBe('notes-25')
  })

  it('is each task’s own', async () => {
    const { store } = await renderAgents()
    fireEvent.click(tab('docs-503'))

    await act(() => store.getState().selectAgentTab('t2', 'elsewhere'))

    expect(shown()).toBe('docs-503')
    expect(store.getState().agentTabs).toEqual({ t1: 'docs-503', t2: 'elsewhere' })
  })
})

describe('the active tabs’ shared width, and the caret’s dropdown (#617)', () => {
  const layout = { clientWidth: 400 }
  const observers = new Set<() => void>()
  const MANY: HubTask = {
    toolEvents: Array.from({ length: 50 }, (_, index) =>
      hubAgent(`s${String(index)}`, `agent-${String(index)}`, 60 - index, index < 40 ? finished(1, 'Done.') : {}),
    ),
  }

  beforeEach(() => {
    layout.clientWidth = 400
    observers.clear()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layout.clientWidth)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: () => void
        constructor(callback: () => void) {
          this.callback = callback
        }
        observe = (): void => {
          observers.add(this.callback)
        }
        unobserve = (): void => undefined
        disconnect = (): void => {
          observers.delete(this.callback)
        }
      },
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('has all 10 active tabs and no more, the newest first, sharing the row evenly', async () => {
    await renderAgents(MANY)

    expect(tabs().map((each) => each.title)).toEqual([
      'Main',
      ...Array.from({ length: 10 }, (_, index) => `agent-${String(49 - index)}`),
    ])
    expect(tabs().filter((each) => each.hasAttribute('data-running'))).toHaveLength(10)
  })

  it('crowds past the 56px floor, by a class toggled on the row rather than React state, and names the full agent on the tab’s title even then', async () => {
    await renderAgents(MANY)
    const row = within(strip()).getByRole('presentation')

    // 10 active tabs share 400px, less 9 gaps of 4px: ~36px each, under the 56px floor. Toggled by a ResizeObserver
    // directly on the row (#617), so it costs no tab a re-render: tab() still finds agent-49 by its title.
    expect(row).toHaveClass(styles.crowded ?? '')
    expect(tab('agent-49')).toHaveAttribute('title', 'agent-49')

    layout.clientWidth = 2000
    for (const observer of observers) observer()
    expect(row).not.toHaveClass(styles.crowded ?? '')
  })

  it('has a caret with the finished count, hidden once none are left', async () => {
    await renderAgents(MANY)

    expect(caret()).toHaveTextContent('40')
    expect(caret()).toHaveAttribute('aria-label', '40 finished subagents')
    expect(caret()).toHaveAttribute('aria-expanded', 'false')

    const onlyActive = { toolEvents: MANY.toolEvents?.filter((_, index) => index >= 40) }
    cleanup()
    await renderAgents(onlyActive)
    expect(caret()).toBeNull()
  })

  it('opens the finished ones newest first, every one of them, capped and scrolling past it by CSS alone', async () => {
    await renderAgents(MANY)

    // Once open, Floating UI hides the rest of the page from assistive technology, the caret included (as the
    // workspace switcher's own menu does): keep the reference from before, rather than query for it again.
    const button = caret()
    if (button === null) throw new Error('No caret in the strip.')
    fireEvent.click(button)
    await act(() => Promise.resolve())

    expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Finished subagents' })
    expect(menu).toHaveTextContent(/^Finished, newest first/)
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(40)
    expect(items[0]).toHaveTextContent('agent-391m')
    expect(items.at(-1)).toHaveTextContent('agent-01m')
  })

  it('picks a finished one from the dropdown, as a temporary tab after the active ones', async () => {
    await renderAgents(MANY)

    await pickFinished('agent-20')

    expect(shown()).toBe('agent-20')
    expect(tabs().at(-1)?.title).toBe('agent-20')
    expect(within(tab('agent-20')).getByRole('img', { name: 'Finished' })).toBeInTheDocument()
  })
})

it('shows the chosen child model with or without a todo and keeps the saved route visible after disabling it', async () => {
  const routed = {
    ...DOCS,
    name: 'mcp__glade-agents__dispatch',
    input: { ...DOCS.input, model: 'openrouter:sample/flash@sample-host' },
  }
  await renderAgents({ ...SHIP, toolEvents: [routed], filings: [] })
  fireEvent.click(tab('docs-503'))
  expect(line()).toHaveTextContent('openrouter:sample/flash@sample-host')
  expect(line()).toHaveTextContent('Running')
})

describe('the line under the strip on Main’s tab (#566)', () => {
  /** Main working, with its status summary set. */
  async function renderMainLine(fields: Partial<ReturnType<typeof sampleTask>> = {}): Promise<HubStore> {
    const main = {
      ...hubMain(SHIP),
      tasks: [
        {
          ...sampleTask('t1', 'w1'),
          createdAt: minutesAgo(42),
          activity: TaskActivity.Working,
          status: 'Throttles applied to the three viewsets; measuring /search',
          ...fields,
        },
      ],
    }
    const hub: HubStore = { ...storeWrapper(main), main }
    await act(() => hub.store.getState().hydrate())
    render(<AgentsTab taskId="t1" rootPath="/Users/sample/code/api" />, { wrapper: hub.wrapper })
    await act(() => Promise.resolve())
    return hub
  }

  it('names the model it runs on, then its status and state under that', async () => {
    await renderMainLine()
    expect(line()).toHaveTextContent('Sample 1')
    expect(line()).toHaveTextContent('Throttles applied to the three viewsets; measuring /search')
    expect(line()).toHaveTextContent('Running · 42m')
  })

  it('no longer says Running once the task stops', async () => {
    const { fake } = await renderMainLine()
    act(() => {
      fake.emit({
        type: EventType.TaskUpdated,
        task: { ...sampleTask('t1', 'w1'), createdAt: minutesAgo(42), activity: TaskActivity.Waiting },
      })
    })
    expect(line()).not.toHaveTextContent('Running · 42m')
  })

  it('falls back to the tool call Main is working on while it has set no status, and says nothing then when it waits', async () => {
    // Main has set no status, and is only waiting: no fallback, and no state.
    await renderMainLine({ status: '' })
    expect(line()).not.toHaveTextContent('Grep throttle')
    expect(line()).not.toHaveTextContent('Running · 42m')
    cleanup()

    // Working, its running Grep is the line, beside the state.
    const events = [
      ...(SHIP.toolEvents ?? []),
      call('main-grep', 1, {
        name: 'Grep',
        input: { pattern: 'throttle' },
        state: ToolCallState.Running,
        output: null,
      }),
    ]
    const working = {
      ...hubMain({ ...SHIP, toolEvents: events }),
      tasks: [
        {
          ...sampleTask('t1', 'w1'),
          createdAt: minutesAgo(42),
          activity: TaskActivity.Working,
          status: '',
        },
      ],
    }
    const hub: HubStore = { ...storeWrapper(working), main: working }
    await act(() => hub.store.getState().hydrate())
    render(<AgentsTab taskId="t1" rootPath="/Users/sample/code/api" />, { wrapper: hub.wrapper })
    await act(() => Promise.resolve())
    expect(line()).toHaveTextContent('Grep throttle')
    expect(line()).toHaveTextContent('Running · 42m')
  })

  it('shows a subagent’s model · provider above its working-on line', async () => {
    const routed = {
      ...LIMITS,
      input: { ...LIMITS.input, model: 'zai/glm-5.3-flash' },
    }
    const main = hubMain({ ...SHIP, toolEvents: [routed] })
    const hub: HubStore = { ...storeWrapper(main), main }
    await act(() => hub.store.getState().hydrate())
    render(<AgentsTab taskId="t1" />, { wrapper: hub.wrapper })
    await act(() => Promise.resolve())
    fireEvent.click(tab('limits-502'))
    expect(line()).toHaveTextContent('zai/glm-5.3-flash')
    expect(line()).toHaveTextContent('Working on #502 Per-key limits for /search')
    expect(line()).toHaveTextContent('Running · 6m')
  })
})

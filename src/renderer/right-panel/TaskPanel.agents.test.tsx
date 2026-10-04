// The right panel with the todo hub's hidden switch on (P16, #536): Agents · Files · Todos, the Agents tab in place of
// Tool calls and Subagents, and what pointed at those tabs pointing at it.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import {
  DividerKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type ToolCallEvent,
  type ToolEvent,
  type UiStateEntry,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { sampleTask } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { hubAgent, hubFiling, hubMain, hubTodo, minutesAgo, refOf, type HubTask } from '../todos/test-hub'
import { HIGHLIGHT_CLASS } from '../tool-log/ToolLog'
import { parsePanelTabSelection } from './panelModel'
import { TaskPanel } from './TaskPanel'

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: `event-${id}`,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(20),
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: `api/${id}.py` },
    output: 'a\nb',
    state: ToolCallState.Done,
    finishedAt: minutesAgo(20),
    toolUseId: id,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

const FIX = hubAgent('fix-501', 'fix-501', 18, {
  state: ToolCallState.Done,
  output: 'Opened PR #511.',
  finishedAt: minutesAgo(2),
})
const DOCS = hubAgent('docs-503', 'docs-503', 9)
const TURN_TWO: ToolEvent = {
  id: 'd2',
  taskId: 't1',
  turn: 2,
  createdAt: minutesAgo(10),
  kind: ToolEventKind.Divider,
  dividerKind: DividerKind.Turn,
}
const SHIP: HubTask = {
  todos: [
    hubTodo('1', '#501 Return Retry-After on 429s'),
    hubTodo('2', '#503 Document the rate limits', TodoState.Todo),
  ],
  toolEvents: [
    call('views'),
    FIX,
    call('throttle', { parentToolUseId: 'fix-501' }),
    TURN_TWO,
    call('urls', { turn: 2 }),
    { ...DOCS, turn: 2 },
  ],
  filings: [hubFiling(refOf.subagent('fix-501'), '1'), hubFiling(refOf.subagent('docs-503'), '2')],
}

interface Setup {
  readonly task?: HubTask
  readonly uiState?: readonly UiStateEntry[]
  readonly hub?: boolean
  readonly agentTabs?: Record<string, string>
  readonly selected?: boolean
}

async function renderPanel({
  task = SHIP,
  uiState = [],
  hub = true,
  agentTabs = {},
  selected = true,
}: Setup = {}): Promise<StoreWrapper> {
  const main = hubMain(task)
  const wrapper = storeWrapper({
    ...main,
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')],
    settings: { ...DEFAULT_SETTINGS, todoHubEnabled: hub },
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
      ...uiState,
    ],
    agentTabs,
  })
  render(<TaskPanel />, { wrapper: wrapper.wrapper })
  await act(() => wrapper.store.getState().hydrate())
  await act(() => Promise.resolve())
  return wrapper
}

const panelTabs = (): HTMLElement => screen.getByRole('tablist', { name: 'Task panels' })
const tabNames = (): string[] =>
  within(panelTabs())
    .getAllByRole('tab')
    .map((each) => each.textContent)
const panelTab = (name: RegExp): HTMLElement => within(panelTabs()).getByRole('tab', { name })
const strip = (): HTMLElement => screen.getByRole('tablist', { name: 'Agents' })
const agentTab = (name: string): HTMLElement => within(strip()).getByRole('tab', { name: new RegExp(`${name}$`) })
const shownAgent = (): string | undefined =>
  within(strip())
    .getAllByRole('tab')
    .find((each) => each.getAttribute('aria-selected') === 'true')?.title
const log = (): HTMLElement => screen.getByRole('log', { name: 'Tool log' })

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

describe('the right panel with the todo hub on', () => {
  it('has three tabs, Agents · Files · Todos, and opens on Agents, counted with Main', async () => {
    await renderPanel()

    expect(tabNames()).toEqual(['Agents 3', 'Files', 'Todos 0/2'])
    expect(panelTab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
    expect(shownAgent()).toBe('Main')
    // Main's list is the Tool calls tab's: its own calls, each turn's divider, and its subagents' calls as one row each.
    expect(within(log()).getAllByRole('button')).toHaveLength(4)
    expect(within(log()).getByRole('separator')).toHaveAccessibleName(/^turn 2/)
    expect(log()).not.toHaveTextContent('throttle.py')
  })

  it('counts Main alone for a task with no subagents, and nothing with no task', async () => {
    const { store } = await renderPanel({ task: { toolEvents: [call('views')] } })
    expect(tabNames()).toEqual(['Agents 1', 'Files', 'Todos'])

    await act(() => store.getState().selectTask(null))
    expect(tabNames()).toEqual(['Agents', 'Files', 'Todos'])
    expect(screen.queryByRole('tablist', { name: 'Agents' })).toBeNull()
  })

  it('is exactly today’s seven tabs with the switch off, with no Agents tab and nothing of it read', async () => {
    const { fake } = await renderPanel({ hub: false, agentTabs: { t1: 'fix-501' } })

    expect(tabNames()).toEqual([
      'Tool calls 4',
      'Files',
      'Todos 0/2',
      'Artifacts',
      'Subagents 2',
      'Watchers',
      'Changes',
    ])
    expect(panelTab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tablist', { name: 'Agents' })).toBeNull()
    // The Tool calls tab's Agent call is a call like any other: it opens its output.
    fireEvent.click(within(log()).getByRole('button', { name: /fix-501/ }))
    expect(within(log()).getByLabelText('Agent output')).toHaveTextContent('Opened PR #511.')
    const commands = fake.invoke.mock.calls.map(([command]) => command)
    expect(commands).not.toContain(CommandName.TodoHubGet)
    expect(commands).not.toContain(CommandName.AgentsSetTab)
  })

  it('opens a workspace left on a tab the hub replaced on Agents, and remembers the tab you pick', async () => {
    const { store } = await renderPanel({ uiState: [{ key: UiStateKey.RightPanelTabs, value: '{"w1":"watchers"}' }] })
    expect(panelTab(/^Agents/)).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(panelTab(/^Todos/))
    expect(parsePanelTabSelection(store.getState().uiState[UiStateKey.RightPanelTabs])).toEqual({ w1: 'todos' })
    fireEvent.click(panelTab(/^Agents/))
    expect(parsePanelTabSelection(store.getState().uiState[UiStateKey.RightPanelTabs])).toEqual({ w1: 'agents' })
    expect(shownAgent()).toBe('Main')
  })

  it('follows the switch as it’s turned on mid-task, and off again', async () => {
    const { fake } = await renderPanel({ hub: false, uiState: [{ key: UiStateKey.RightPanelTab, value: 'subagents' }] })
    expect(panelTab(/^Subagents/)).toHaveAttribute('aria-selected', 'true')

    act(() => {
      fake.emit({ type: EventType.SettingsChanged, settings: { ...DEFAULT_SETTINGS, todoHubEnabled: true } })
    })
    await act(() => Promise.resolve())
    expect(tabNames()).toEqual(['Agents 3', 'Files', 'Todos 0/2'])
    expect(panelTab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(agentTab('docs-503'))
    expect(shownAgent()).toBe('docs-503')

    // Off again: the tab the workspace was on, as it was.
    act(() => {
      fake.emit({ type: EventType.SettingsChanged, settings: DEFAULT_SETTINGS })
    })
    expect(tabNames()).toHaveLength(7)
    expect(panelTab(/^Subagents/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tablist', { name: 'Agents' })).toBeNull()
  })

  it('keeps each task on its own agent as you switch between tasks', async () => {
    const { store } = await renderPanel()
    fireEvent.click(agentTab('docs-503'))

    await act(() => store.getState().selectTask('t2'))
    expect(tabNames()).toEqual(['Agents 1', 'Files', 'Todos'])
    expect(shownAgent()).toBe('Main')
    expect(screen.getByRole('tabpanel', { name: /Main$/ })).toHaveTextContent('No tool calls yet.')

    await act(() => store.getState().selectTask('t1'))
    expect(shownAgent()).toBe('docs-503')
  })

  it('opens on the agent a task was left on before a relaunch', async () => {
    await renderPanel({ agentTabs: { t1: 'fix-501' } })

    expect(shownAgent()).toBe('fix-501')
    expect(log()).toHaveTextContent('api/throttle.py')
    expect(screen.getByText(/^Worked on/)).toHaveTextContent('Worked on #501 Return Retry-After on 429s')
  })

  describe('showing a turn the chat asks for', () => {
    it('goes to Main’s tab of Agents from a subagent’s, scrolled to the turn and highlighted', async () => {
      const { store } = await renderPanel({ agentTabs: { t1: 'fix-501' } })
      expect(shownAgent()).toBe('fix-501')

      act(() => {
        store.getState().focusTurn('t1', 2)
      })

      expect(shownAgent()).toBe('Main')
      const turnTwo = within(log()).getByRole('separator')
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(turnTwo)
      expect(turnTwo).toHaveClass(HIGHLIGHT_CLASS)
    })

    it('opens the panel at Agents from another tab, collapsed or not', async () => {
      const { store } = await renderPanel({
        uiState: [
          { key: UiStateKey.RightPanelCollapsed, value: 'true' },
          { key: UiStateKey.RightPanelTabs, value: '{"w1":"files"}' },
        ],
      })
      expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull()

      act(() => {
        store.getState().focusTurn('t1', 1)
      })

      expect(panelTab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
      expect(shownAgent()).toBe('Main')
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(
        within(log()).getAllByRole('button')[0]?.closest('[data-turn-start]'),
      )
    })

    it('leaves the panel alone for a turn of a task that isn’t showing', async () => {
      const { store } = await renderPanel({ uiState: [{ key: UiStateKey.RightPanelTabs, value: '{"w1":"files"}' }] })

      act(() => {
        store.getState().focusTurn('t2', 1)
      })

      expect(panelTab(/^Files/)).toHaveAttribute('aria-selected', 'true')
    })
  })

  it('opens a task a plugin asks for on its subagent’s tab', async () => {
    const { fake, store } = await renderPanel({
      selected: false,
      uiState: [{ key: UiStateKey.RightPanelTabs, value: '{"w1":"todos"}' }],
    })

    act(() => {
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't1', subagentId: 'docs-503' })
    })
    await vi.waitFor(() => {
      expect(store.getState().agentTabs).toEqual({ t1: 'docs-503' })
    })
    await act(() => Promise.resolve())

    expect(panelTab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
    expect(shownAgent()).toBe('docs-503')
    expect(store.getState().subagentFocus).toBeNull()
  })

  describe('the todo a subagent’s tab names', () => {
    it('shows in the Todos tab when clicked: its card scrolled into view, the focus on its head', async () => {
      await renderPanel({ agentTabs: { t1: 'docs-503' } })

      fireEvent.click(screen.getByRole('button', { name: '#503 Document the rate limits' }))
      await act(() => Promise.resolve())

      expect(panelTab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
      const head = document.activeElement
      expect(head).toHaveAttribute('data-todo-head')
      expect(head).toHaveTextContent('#503 Document the rate limits')
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(head?.closest('[data-todo="2"]'))
    })

    it('is shown once, not again when you come back to the Todos tab', async () => {
      const { store } = await renderPanel({ agentTabs: { t1: 'docs-503' } })
      fireEvent.click(screen.getByRole('button', { name: '#503 Document the rate limits' }))
      await act(() => Promise.resolve())
      scrollIntoView.mockClear()

      fireEvent.click(panelTab(/^Files/))
      fireEvent.click(panelTab(/^Todos/))
      await act(() => Promise.resolve())
      expect(scrollIntoView).not.toHaveBeenCalled()

      // Asked for again, it is.
      act(() => {
        store.getState().showTodo('t1', '1')
      })
      expect(document.activeElement).toHaveTextContent('#501 Return Retry-After on 429s')
    })

    it('waits for a todo that isn’t in the list yet, and ignores one asked for another task', async () => {
      const { fake, store } = await renderPanel()

      act(() => {
        store.getState().showTodo('t2', '1')
        store.getState().showTodo('t1', '7')
      })
      expect(panelTab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
      expect(scrollIntoView).not.toHaveBeenCalled()

      act(() => {
        fake.emit({
          type: EventType.TodosChanged,
          taskId: 't1',
          todos: { items: [...(SHIP.todos ?? []), hubTodo('7', 'Draft the release notes')], updatedAt: minutesAgo(0) },
        })
      })
      expect(document.activeElement).toHaveTextContent('Draft the release notes')
      expect(scrollIntoView).toHaveBeenCalledOnce()
    })
  })
})

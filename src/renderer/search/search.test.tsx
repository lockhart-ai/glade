import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, type SearchQueryResponse } from '../../shared/bridge'
import { MessageRole, TaskState, UiStateKey, type Message, type Task } from '../../shared/domain'
import { SearchField } from '../../shared/search'
import { App } from '../App'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleMessage,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { SEARCH_NOTE } from './SearchResults'

const TASKS: Task[] = [
  {
    ...sampleTask('t1', 'w1', 'Add rate limiting to public API'),
    objective: 'Add per-key rate limiting. Over the limit, return 429 with a Retry-After header.',
    status: 'Per-key rate limiting is live.',
    state: TaskState.Done,
    doneAt: 3_000,
  },
  { ...sampleTask('t2', 'w1', 'Add webhook retries'), status: 'Backing off' },
  { ...sampleTask('t3', 'w1', 'Fix flaky login test'), status: 'Found the race' },
  { ...sampleTask('t4', 'w2', 'Honour Retry-After elsewhere') },
]

const MESSAGES: Message[] = [
  sampleMessage('m1', 't1', 'Add per-key rate limiting. Over the limit, return 429 with a Retry-After header.'),
  {
    ...sampleMessage('m2', 't1', 'Tests pass for the 429 response and the **Retry-After** header.'),
    role: MessageRole.Agent,
  },
  sampleMessage('m3', 't2', 'Honour the Retry-After header when a receiver sends one.'),
  sampleMessage('m4', 't3', 'The client ignores Retry-After in the test helper.'),
]

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

async function renderApp(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: [...TASKS],
      messages: [...MESSAGES],
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function searchField(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search tasks' })
}

function type(text: string): void {
  fireEvent.change(searchField(), { target: { value: text } })
}

function results(): HTMLElement {
  return screen.getByRole('region', { name: 'Search results' })
}

/** Each result row's text, with the marked matches in [brackets]. */
function resultRows(): string[] {
  return within(results())
    .queryAllByRole('button')
    .map((row) => marked(row))
}

/** An element's text with each `<mark>` in [brackets]. */
function marked(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const mark of copy.querySelectorAll('mark')) mark.textContent = `[${mark.textContent}]`
  return copy.textContent
}

async function searchFor(text: string, count: number): Promise<void> {
  type(text)
  await waitFor(() => {
    expect(within(results()).getByRole('heading')).toHaveTextContent(`Results${String(count)}`)
  })
}

describe('searching', () => {
  it('replaces the task list and chips with the results as you type, each with its matches marked', async () => {
    const { invoke } = await renderApp()
    expect(screen.getByRole('group', { name: 'Filter tasks' })).toBeInTheDocument()

    await searchFor('Retry-After', 3)

    expect(invoke).toHaveBeenCalledWith(CommandName.SearchQuery, { workspaceId: 'w1', text: 'Retry-After' })
    expect(screen.queryByRole('region', { name: 'Active' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Filter tasks' })).toBeNull()
    expect(resultRows()).toEqual([
      expect.stringMatching(
        /^Add rate limiting to public API.*Over the limit, return 429 with a \[Retry-After\] header\.$/,
      ),
      expect.stringMatching(/^Add webhook retries.*Honour the \[Retry-After\] header when a receiver sends one\.$/),
      expect.stringMatching(/^Fix flaky login test.*The client ignores \[Retry-After\] in the test helper\.$/),
    ])
    expect(results()).toHaveTextContent(SEARCH_NOTE)
  })

  it('marks a title match in the title, with the task’s status line below it', async () => {
    await renderApp()

    await searchFor('flaky', 1)

    expect(resultRows()).toEqual([expect.stringMatching(/^Fix \[flaky\] login test.*Found the race$/)])
  })

  it('counts no results for a search that matches nothing, or only another workspace’s tasks', async () => {
    await renderApp()

    await searchFor('elsewhere', 0)

    expect(resultRows()).toEqual([])
    expect(results()).toHaveTextContent(SEARCH_NOTE)
  })

  it('keeps the task list for a search of only spaces', async () => {
    const { invoke } = await renderApp()

    type('   ')

    expect(screen.getByRole('region', { name: 'Active' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Search results' })).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith(CommandName.SearchQuery, expect.anything())
  })

  it('searches once typing pauses, not on every keystroke', async () => {
    const { invoke } = await renderApp()

    type('R')
    type('Re')
    type('Ret')
    await searchFor('Retr', 3)

    const searches = invoke.mock.calls.filter(([command]) => command === CommandName.SearchQuery)
    expect(searches).toEqual([[CommandName.SearchQuery, { workspaceId: 'w1', text: 'Retr' }]])
  })

  it('drops an answer to a search you’ve since typed past', async () => {
    const answers: ((response: SearchQueryResponse) => void)[] = []
    await renderApp({
      [CommandName.SearchQuery]: () =>
        new Promise<SearchQueryResponse>((resolve) => {
          answers.push(resolve)
        }),
    })
    const answer = (index: number, taskId: string): Promise<void> =>
      act(async () => {
        answers[index]?.({
          results: [{ taskId, field: SearchField.Title, snippet: [{ text: 'x', match: true }] }],
        })
        await Promise.resolve()
      })

    type('rate')
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })
    type('webhook')
    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    await answer(1, 't2')
    await answer(0, 't1')

    expect(resultRows()).toEqual([expect.stringMatching(/^Add \[webhook\] retries/)])
  })

  it('shows a toast when the search fails, keeping the results it had', async () => {
    const { invoke } = await renderApp()
    await searchFor('flaky', 1)
    invoke.mockImplementationOnce(() => refuse(bridgeError(BridgeErrorCode.Internal, 'The index is locked')))

    type('flak')

    expect(await screen.findByText('The index is locked')).toBeInTheDocument()
    expect(resultRows()).toEqual([expect.stringMatching(/^Fix \[flaky\] login test/)])
  })

  it('ends with Esc, or by emptying the field, bringing the task list back', async () => {
    await renderApp()
    await searchFor('flaky', 1)

    fireEvent.keyDown(searchField(), { key: 'Escape' })

    expect(searchField()).toHaveValue('')
    expect(screen.queryByRole('region', { name: 'Search results' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Active' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Filter tasks' })).toBeInTheDocument()

    await searchFor('flaky', 1)
    type('')
    expect(screen.getByRole('region', { name: 'Active' })).toBeInTheDocument()
  })

  it('leaves Esc alone in an empty field, and other keys in the field', async () => {
    await renderApp()

    expect(fireEvent.keyDown(searchField(), { key: 'Escape' })).toBe(true)
    await searchFor('flaky', 1)
    expect(fireEvent.keyDown(searchField(), { key: 'Enter' })).toBe(true)
    expect(searchField()).toHaveValue('flaky')
  })
})

describe('opening a result', () => {
  it('selects its task, and marks the matches in its header and chat until the search changes or ends', async () => {
    const { store } = await renderApp()
    await searchFor('Retry-After', 3)

    fireEvent.click(within(results()).getByRole('button', { name: /^Add rate limiting to public API/ }))

    await waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('t1')
    })
    expect(within(results()).getByRole('button', { name: /^Add rate limiting/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    const header = screen.getByRole('region', { name: 'Task header' })
    expect(marked(within(header).getByRole('group', { name: 'Objective' }))).toContain('with a [Retry-After] header.')
    const chat = await screen.findByRole('log', { name: 'Conversation' })
    await waitFor(() => {
      expect(chat.querySelectorAll('mark')).toHaveLength(2)
    })
    expect(marked(within(chat).getByRole('article', { name: 'You' }))).toContain('with a [Retry-After] header.')
    // In the agent's Markdown too, inside its formatting.
    expect(marked(within(chat).getByRole('article', { name: 'Agent' }))).toContain('the [Retry-After] header.')

    await searchFor('limiting', 1)
    expect(marked(within(header).getByRole('heading', { level: 1 }))).toBe('Add rate [limiting] to public API')
    expect(marked(within(header).getByRole('group', { name: 'Outcome' }))).toContain('Per-key rate [limiting] is live.')
    expect(chat.querySelectorAll('mark')).toHaveLength(1)

    fireEvent.keyDown(searchField(), { key: 'Escape' })
    expect(screen.getByRole('main', { name: 'Task' }).querySelectorAll('mark')).toHaveLength(0)
    expect(store.getState().selectedTaskId).toBe('t1')
  })
})

describe('⌘F', () => {
  it('focuses the search field from anywhere, selecting what’s in it', async () => {
    await renderApp()
    type('flaky')
    searchField().blur()

    expect(fireEvent.keyDown(window, { key: 'f', metaKey: true })).toBe(false)

    expect(searchField()).toHaveFocus()
    expect([searchField().selectionStart, searchField().selectionEnd]).toEqual([0, 5])
    fireEvent.keyDown(window, { key: 'F', metaKey: true })
    expect(searchField()).toHaveFocus()
  })

  it('shows a collapsed sidebar, with the search it was showing, and focuses the field', async () => {
    const { store } = await renderApp()
    type('flaky')
    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull()

    fireEvent.keyDown(window, { key: 'f', metaKey: true })

    expect(store.getState().uiState[UiStateKey.SidebarCollapsed]).toBe('false')
    expect(searchField()).toHaveFocus()
    expect(searchField()).toHaveValue('flaky')
  })

  it('leaves the focus alone when the sidebar comes back by other means after a ⌘F', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    screen.getByRole('button', { name: 'Show task list' }).focus()

    fireEvent.keyDown(window, { key: 'b', metaKey: true })

    expect(searchField()).not.toHaveFocus()
  })

  it.each([
    ['F alone', { metaKey: false }],
    ['⌥⌘F', { altKey: true }],
    ['⌃⌘F', { ctrlKey: true }],
    ['⇧⌘F', { shiftKey: true }],
    ['⌘G', { key: 'g' }],
  ])('ignores %s', async (_, init) => {
    const { store } = await renderApp()

    expect(fireEvent.keyDown(window, { key: 'f', metaKey: true, ...init })).toBe(true)
    expect(store.getState().searchFocusRequest).toBe(0)
    expect(searchField()).not.toHaveFocus()
  })

  it('stops listening once the layout is gone', async () => {
    const { store } = await renderApp()
    act(() => {
      store.setState({ workspaces: [] })
    })

    fireEvent.keyDown(window, { key: 'f', metaKey: true })

    expect(store.getState().searchFocusRequest).toBe(0)
  })
})

describe('a result’s context menu', () => {
  it('is the task’s menu, as in the task list, and its Rename… renames in the result’s row', async () => {
    const { store } = await renderApp()
    await searchFor('Retry-After', 3)

    fireEvent.contextMenu(within(results()).getByRole('button', { name: /^Add rate limiting to public API/ }))

    expect(screen.getByRole('menu', { name: 'Task actions' })).toHaveTextContent(/^Open↵Pin to topRename…Reopen/)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rename/ }))
    expect(store.getState().renamingTaskId).toBe('t1')
    const field = within(results()).getByRole('textbox', { name: 'Task title' })
    fireEvent.change(field, { target: { value: 'Rate limit the public API' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => {
      expect(store.getState().tasks.t1?.title).toBe('Rate limit the public API')
    })
  })
})

describe('opening a result scrolls the chat to the first match', () => {
  /** Places every `<mark>` at `top` within a chat 500px tall, and records the scrolls asked for. */
  function layout(top: number): ReturnType<typeof vi.fn> {
    const scrollIntoView = vi.fn()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const mark = this.tagName === 'MARK'
      return DOMRect.fromRect({ x: 0, y: mark ? top : 0, width: 100, height: mark ? 20 : 500 })
    })
    Element.prototype.scrollIntoView = scrollIntoView
    return scrollIntoView
  }

  async function openFirstResult(): Promise<void> {
    await searchFor('Retry-After', 3)
    fireEvent.click(within(results()).getByRole('button', { name: /^Add rate limiting to public API/ }))
    await waitFor(() => {
      expect(screen.getByRole('log', { name: 'Conversation' }).querySelectorAll('mark')).toHaveLength(2)
    })
  }

  it('smoothly, when it’s off screen', async () => {
    const scrollIntoView = layout(-400)
    await renderApp()

    await openFirstResult()

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center' })
    })
    vi.restoreAllMocks()
  })

  it('not at all when it’s in view, or when the chat has no match', async () => {
    const scrollIntoView = layout(100)
    const { store } = await renderApp()

    await openFirstResult()
    await searchFor('flaky', 1)
    await act(() => store.getState().openSearchResult('t3'))

    expect(store.getState().matchRevealRequest).toBe(2)
    expect(scrollIntoView).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

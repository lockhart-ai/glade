import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  FileContentKind,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type FileContent,
  type OpenFiles,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { colors } from '../tokens'
import { FilesTab, type FileLineFocus } from './FilesTab'

const ROOT = sampleWorkspace('w1').rootPath
const AT = new Date(2026, 8, 23, 11, 22).getTime()

function call(id: string, name: string, path: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name,
    input: { file_path: `${ROOT}/${path}` },
    output: 'ok',
    state: ToolCallState.Done,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    ...overrides,
  }
}

const EVENTS: ToolEvent[] = [
  call('c1', 'Read', 'config/settings.py'),
  call('c2', 'Edit', 'docs/rate-limits.md'),
  call('c3', 'Write', 'api/throttles.py'),
]

const RATE_LIMITS = [
  '# Rate limits',
  '',
  'Every request counts against the key that made it.',
  '',
  '| Endpoint | Limit |',
  '|----------|-------|',
  '| /search  | 60    |',
  '| Else     | 120   |',
  '',
].join('\n')

const FILES: Readonly<Record<string, FileContent>> = {
  'docs/rate-limits.md': { kind: FileContentKind.Text, text: RATE_LIMITS, truncated: false, size: RATE_LIMITS.length },
  'api/throttles.py': {
    kind: FileContentKind.Text,
    text: 'class KeyThrottle:\n    rate = 120\n',
    truncated: false,
    size: 34,
  },
  'config/settings.py': { kind: FileContentKind.Text, text: 'DEBUG = False\n', truncated: false, size: 14 },
}

interface Setup {
  readonly toolEvents?: ToolEvent[]
  readonly openFiles?: OpenFiles
  readonly files?: Readonly<Record<string, FileContent>>
  readonly overrides?: Partial<FakeHandlers>
  readonly focus?: FileLineFocus
}

async function renderTab({ toolEvents = EVENTS, openFiles, files = FILES, overrides = {}, focus }: Setup = {}): Promise<
  FakeBridge & { store: GladeStore; opened: string[] }
> {
  const opened: string[] = []
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      toolEvents: [...toolEvents],
      openFiles: openFiles === undefined ? [] : [openFiles],
      files,
      openedInEditor: opened,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <FilesTab taskId="t1" rootPath={ROOT} focus={focus ?? null} />
    </GladeStoreProvider>,
  )
  return { ...fake, store, opened }
}

function openTabs(): HTMLElement {
  return screen.getByRole('group', { name: 'Open files' })
}

function source(): HTMLElement {
  return screen.getByTestId('source')
}

/** The number and text of each line the viewer shows. */
function shownLines(): [string, string][] {
  return [...source().querySelectorAll('[data-line]')].map((line) => [
    line.firstElementChild?.textContent ?? '',
    line.lastElementChild?.textContent ?? '',
  ])
}

const OPEN: OpenFiles = {
  taskId: 't1',
  paths: ['docs/rate-limits.md', 'api/throttles.py', 'config/settings.py'],
  activePath: 'docs/rate-limits.md',
}

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

describe('FilesTab', () => {
  it('says there are no files yet until the agent touches one', async () => {
    await renderTab({ toolEvents: [] })

    expect(screen.getByText('No files yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'All files in this task' })).toBeNull()
  })

  it('lists the files the agent changed and read, and opens one chosen from the list', async () => {
    const { invoke } = await renderTab()

    expect(screen.getByText('No file open.')).toBeInTheDocument()
    const list = screen.getByRole('button', { name: 'All files in this task' })
    expect(list).toHaveTextContent('3')
    fireEvent.click(list)
    const menu = screen.getByRole('menu', { name: 'Files in this task' })
    expect(menu).toHaveTextContent(/^Changedapi\/throttles\.pydocs\/rate-limits\.mdReadconfig\/settings\.py$/)

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'docs/rate-limits.md' }))

    await waitFor(() => {
      expect(within(openTabs()).getByRole('button', { name: /rate-limits\.md/, pressed: true })).toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: 'docs/rate-limits.md' })
    expect(await screen.findByTestId('source')).toBeInTheDocument()
  })

  it('shows a tab per open file, a blue dot on the ones the agent changed, and switches and closes them', async () => {
    const { invoke } = await renderTab({ openFiles: OPEN })

    const tabs = within(openTabs()).getAllByRole('button', { pressed: undefined })
    expect(tabs.map((tab) => tab.getAttribute('aria-label') ?? tab.textContent)).toEqual([
      'rate-limits.md',
      'Close rate-limits.md',
      'throttles.py',
      'Close throttles.py',
      'settings.py',
      'Close settings.py',
    ])
    expect(within(openTabs()).getAllByRole('img', { name: 'Changed by the agent' })).toHaveLength(2)
    expect(within(within(openTabs()).getByRole('button', { name: 'settings.py' })).queryByRole('img')).toBeNull()

    fireEvent.click(within(openTabs()).getByRole('button', { name: /throttles\.py/, pressed: false }))
    await waitFor(() => {
      expect(screen.getByText('api/throttles.py', { selector: 'span' })).toBeInTheDocument()
    })

    fireEvent.click(within(openTabs()).getByRole('button', { name: 'Close throttles.py' }))
    await waitFor(() => {
      expect(within(openTabs()).queryByRole('button', { name: 'Close throttles.py' })).toBeNull()
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesClose, { taskId: 't1', path: 'api/throttles.py' })
    // The tab after it shows now.
    expect(within(openTabs()).getByRole('button', { name: 'settings.py', pressed: true })).toBeInTheDocument()
  })

  it('shows the file with line numbers, how the agent last touched it, and colours it', async () => {
    await renderTab({ openFiles: OPEN })

    expect(screen.getByText('Edited by the agent · 11:22')).toBeInTheDocument()
    await waitFor(() => {
      expect(shownLines()).toHaveLength(8)
    })
    expect(shownLines()[0]).toEqual(['1', '# Rate limits'])
    expect(shownLines()[6]).toEqual(['7', '| /search  | 60    |'])
    await waitFor(() => {
      const heading = source().querySelector('[data-line="1"] span[style]')
      expect(heading).toHaveStyle({ color: colors['--color-blue-text'], fontWeight: '600' })
    })
  })

  it('says how a read file was last touched', async () => {
    await renderTab({ openFiles: { ...OPEN, activePath: 'config/settings.py' } })

    expect(screen.getByText('Read by the agent · 11:22')).toBeInTheDocument()
  })

  it('switches a Markdown file between its source and a preview', async () => {
    await renderTab({ openFiles: OPEN })
    await screen.findByTestId('source')

    fireEvent.click(screen.getByRole('radio', { name: 'Preview' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Rate limits' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByTestId('source')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }))
    expect(screen.getByTestId('source')).toBeInTheDocument()
  })

  it('offers no preview for a file that isn’t Markdown', async () => {
    await renderTab({ openFiles: { ...OPEN, activePath: 'api/throttles.py' } })
    await screen.findByTestId('source')

    expect(screen.queryByRole('radiogroup', { name: 'Show as' })).toBeNull()
  })

  it('shows the start of a file too large to show whole, with a notice', async () => {
    const text = 'line\n'.repeat(5000)
    await renderTab({
      openFiles: { ...OPEN, activePath: 'config/settings.py' },
      files: { 'config/settings.py': { kind: FileContentKind.Text, text, truncated: true, size: 2.4 * 1024 * 1024 } },
    })

    expect(await screen.findByRole('note')).toHaveTextContent(
      'This file is large (2.4 MB), so only its first 5,000 lines are shown. Open it in your editor to see it all.',
    )
    expect(shownLines()).toHaveLength(5000)
  })

  it('says when a file isn’t text, isn’t there, or can’t be read', async () => {
    await renderTab({
      openFiles: { ...OPEN, activePath: 'api/throttles.py' },
      files: { 'api/throttles.py': { kind: FileContentKind.Binary, size: 2048 } },
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This file isn’t text (2 KB), so it can’t be shown here. Open it in your editor instead.',
    )

    fireEvent.click(within(openTabs()).getByRole('button', { name: /settings\.py/, pressed: false }))
    expect(await screen.findByText('This file isn’t there any more.')).toBeInTheDocument()
  })

  it('says why a file couldn’t be read', async () => {
    await renderTab({
      openFiles: OPEN,
      overrides: {
        [CommandName.FilesRead]: () =>
          refuse(bridgeError(BridgeErrorCode.OutsideWorkspace, 'files.read: docs/rate-limits.md is outside')),
      },
    })

    expect(await screen.findByRole('status')).toHaveTextContent(
      'This file can’t be shown: files.read: docs/rate-limits.md is outside',
    )
  })

  it('says why a file couldn’t be read when the failure isn’t the bridge’s', async () => {
    await renderTab({
      openFiles: OPEN,
      overrides: { [CommandName.FilesRead]: () => Promise.reject(new Error('The window closed')) },
    })

    expect(await screen.findByRole('status')).toHaveTextContent('This file can’t be shown: Error: The window closed')
  })

  it('opens the file showing in the editor, with its button or ⌘⇧E', async () => {
    const { opened } = await renderTab({ openFiles: OPEN })

    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }))
    fireEvent.keyDown(window, { key: 'E', code: 'KeyE', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE', metaKey: true })

    await waitFor(() => {
      expect(opened).toEqual(['docs/rate-limits.md', 'docs/rate-limits.md'])
    })
  })

  it('reads the file again when the agent changes it', async () => {
    const { emit, invoke } = await renderTab({ openFiles: OPEN })
    await waitFor(() => {
      expect(shownLines()).toHaveLength(8)
    })
    const reads = (): number => invoke.mock.calls.filter(([command]) => command === CommandName.FilesRead).length
    const before = reads()

    const edit = call('c4', 'Edit', 'docs/rate-limits.md', { state: ToolCallState.Running, output: null })
    act(() => {
      emit({ type: EventType.ToolEventAppended, toolEvent: edit })
    })
    expect(reads()).toBe(before)
    act(() => {
      emit({ type: EventType.ToolEventUpdated, toolEvent: { ...edit, state: ToolCallState.Done, output: 'ok' } })
    })

    await waitFor(() => {
      expect(reads()).toBe(before + 1)
    })
  })

  it('marks and scrolls to the line the agent shows, while its file shows', async () => {
    await renderTab({ openFiles: OPEN, focus: { path: 'docs/rate-limits.md', line: 7, request: 1 } })
    await waitFor(() => {
      expect(shownLines()).toHaveLength(8)
    })

    expect(source().querySelector('[data-line="7"]')).toHaveAttribute('data-focused', 'true')
    expect(source().querySelectorAll('[data-focused]')).toHaveLength(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('marks no line for another file', async () => {
    await renderTab({ openFiles: OPEN, focus: { path: 'api/throttles.py', line: 1, request: 1 } })
    await waitFor(() => {
      expect(shownLines()).toHaveLength(8)
    })

    expect(source().querySelectorAll('[data-focused]')).toHaveLength(0)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('closes the list when you choose Escape', async () => {
    await renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'All files in this task' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows the tabs of files open without any touched, with the list empty', async () => {
    await renderTab({ toolEvents: [], openFiles: { ...OPEN, paths: ['README.md'], activePath: 'README.md' } })

    expect(screen.getByRole('button', { name: 'All files in this task' })).toBeDisabled()
    expect(await screen.findByText('This file isn’t there any more.')).toBeInTheDocument()
  })
})

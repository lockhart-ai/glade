import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { FolderEntryKind, MAX_SEARCH_RESULTS, type FolderEntry } from '../../shared/browse'
import {
  FileContentKind,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type OpenFiles,
  type ToolCallEvent,
} from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge, type FakeHandlers } from '../store/test-bridge'
import { FilesTab } from './FilesTab'

const ROOT = sampleWorkspace('w1').rootPath

function folder(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: FolderEntryKind.Folder }
}

function file(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: FolderEntryKind.File }
}

/** A made-up workspace, a folder at a time, as `files.listFolder` answers. */
function sampleTree(): Record<string, readonly FolderEntry[]> {
  return {
    '': [folder('api'), folder('docs'), file('README.md')],
    api: [folder('api/tests'), file('api/throttles.py'), file('api/views.py')],
    'api/tests': [file('api/tests/test_throttles.py')],
    docs: [file('docs/rate-limits.md')],
  }
}

const WROTE: ToolCallEvent = {
  id: 'c1',
  taskId: 't1',
  turn: 1,
  createdAt: 1,
  kind: ToolEventKind.ToolCall,
  name: 'Write',
  input: { file_path: `${ROOT}/api/throttles.py` },
  output: 'ok',
  state: ToolCallState.Done,
  finishedAt: null,
  toolUseId: 'use-c1',
  parentToolUseId: null,
  progressSummary: null,
}

interface Setup {
  readonly tree?: Record<string, readonly FolderEntry[]>
  readonly expanded?: string[]
  readonly openFiles?: OpenFiles
  readonly overrides?: Partial<FakeHandlers>
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly tree: Record<string, readonly FolderEntry[]>
  readonly expandedFolders: Record<string, string[]>
  readonly watchedFolders: Record<string, readonly string[]>
  readonly searches: string[]
  readonly unmount: () => void
}

async function renderTab({
  tree = sampleTree(),
  expanded = [],
  openFiles,
  overrides = {},
}: Setup = {}): Promise<Rendered> {
  const expandedFolders: Record<string, string[]> = { t1: [...expanded] }
  const watchedFolders: Record<string, readonly string[]> = {}
  const searches: string[] = []
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      toolEvents: [WROTE],
      openFiles: openFiles === undefined ? [] : [openFiles],
      files: { 'api/throttles.py': { kind: FileContentKind.Text, text: 'rate = 120\n', truncated: false, size: 11 } },
      tree,
      expandedFolders,
      watchedFolders,
      searches,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <FilesTab taskId="t1" rootPath={ROOT} focus={null} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, tree, expandedFolders, watchedFolders, searches, unmount }
}

function theTree(): HTMLElement {
  return screen.getByRole('tree', { name: 'Workspace files' })
}

/** The tree's rows as they show: indented two spaces a level, `+` on an open folder, `-` on a closed one. */
function rows(): string[] {
  return within(theTree())
    .getAllByRole('treeitem')
    .map((row) => {
      const depth = Number(row.getAttribute('aria-level')) - 1
      const open = row.getAttribute('aria-expanded')
      const mark = open === null ? '' : open === 'true' ? '+ ' : '- '
      return `${'  '.repeat(depth)}${mark}${row.textContent}`
    })
}

function row(name: string): HTMLElement {
  return within(theTree()).getByRole('treeitem', { name })
}

function search(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search files' })
}

function listed(invoke: FakeBridge['invoke']): string[] {
  return invoke.mock.calls.flatMap(([command, request]) =>
    command === CommandName.FilesListFolder && 'path' in request && typeof request.path === 'string'
      ? [request.path]
      : [],
  )
}

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Browse tab', () => {
  it('shows the workspace’s root first, before any file tab, loading a folder only once it’s opened', async () => {
    const { invoke } = await renderTab({ openFiles: { taskId: 't1', paths: ['README.md'], activePath: null } })

    await waitFor(() => {
      expect(rows()).toEqual(['- api', '- docs', 'README.md'])
    })
    const browse = screen.getByRole('button', { name: 'Browse files', pressed: true })
    // Before the open files' tabs, which keep their place.
    const tabs = screen.getByRole('group', { name: 'Open files' })
    expect(browse.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(tabs).getByRole('button', { name: 'README.md', pressed: false })).toBeInTheDocument()
    expect(listed(invoke)).toEqual([''])
  })

  it('opens and closes folders in place, remembering them for the task, and lists one again each time it opens', async () => {
    const { invoke, expandedFolders } = await renderTab()
    await waitFor(() => {
      expect(rows()).toEqual(['- api', '- docs', 'README.md'])
    })

    fireEvent.click(row('api'))
    await waitFor(() => {
      expect(rows()).toEqual(['+ api', '  - tests', '  throttles.py', '  views.py', '- docs', 'README.md'])
    })
    fireEvent.click(row('tests'))
    await waitFor(() => {
      expect(rows()).toContain('    test_throttles.py')
    })
    fireEvent.click(row('api'))
    expect(rows()).toEqual(['- api', '- docs', 'README.md'])

    expect(invoke).toHaveBeenCalledWith(CommandName.FilesSetFolderExpanded, {
      taskId: 't1',
      path: 'api',
      expanded: true,
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesSetFolderExpanded, {
      taskId: 't1',
      path: 'api',
      expanded: false,
    })
    expect(expandedFolders.t1).toEqual(['api/tests'])

    // Opened again, its open folder inside still open, and both listed afresh.
    fireEvent.click(row('api'))
    await waitFor(() => {
      expect(rows()).toContain('    test_throttles.py')
    })
    expect(listed(invoke)).toEqual(['', 'api', 'api/tests', 'api'])
  })

  it('opens the folders the task left open, as it left them, after a relaunch', async () => {
    const { invoke } = await renderTab({ expanded: ['api', 'api/tests', 'docs/old'] })

    await waitFor(() => {
      expect(rows()).toEqual([
        '+ api',
        '  + tests',
        '    test_throttles.py',
        '  throttles.py',
        '  views.py',
        '- docs',
        'README.md',
      ])
    })
    // A folder open inside a closed one isn't loaded until it shows.
    expect(listed(invoke)).toEqual(['', 'api', 'api/tests'])
  })

  it('opens a file in its tab, and keeps the tree as it was to come back to', async () => {
    const { invoke } = await renderTab({ expanded: ['api'] })
    await waitFor(() => {
      expect(rows()).toContain('  throttles.py')
    })

    fireEvent.click(row('throttles.py'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Browse files', pressed: false })).toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: 'api/throttles.py' })
    expect(await screen.findByTestId('editor')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Browse files', pressed: true })).toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesBrowse, { taskId: 't1' })
    expect(rows()).toContain('  throttles.py')
    expect(listed(invoke)).toEqual(['', 'api'])
  })

  it('marks the files the agent changed with the blue dot', async () => {
    await renderTab({ expanded: ['api'] })
    await waitFor(() => {
      expect(rows()).toContain('  views.py')
    })
    expect(within(row('throttles.py')).getByRole('img')).toBeInTheDocument()
    expect(within(row('views.py')).queryByRole('img')).toBeNull()
  })

  it('moves with the arrows, opens and closes folders with → and ←, and opens a file with ↩', async () => {
    const { invoke } = await renderTab()
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    const key = (name: string, keyName: string, init: KeyboardEventInit = {}): void => {
      fireEvent.keyDown(row(name), { key: keyName, ...init })
    }

    // ↓ from the search goes into the tree.
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(row('api')).toHaveFocus()
    key('api', 'ArrowRight')
    await waitFor(() => {
      expect(rows()).toContain('  - tests')
    })
    key('api', 'ArrowRight')
    expect(row('tests')).toHaveFocus()
    key('tests', 'ArrowDown')
    expect(row('throttles.py')).toHaveFocus()
    key('throttles.py', 'ArrowLeft')
    expect(row('api')).toHaveFocus()
    key('api', 'ArrowLeft')
    expect(rows()).toEqual(['- api', '- docs', 'README.md'])
    key('api', 'End')
    expect(row('README.md')).toHaveFocus()
    // Modified keys are the window's.
    key('README.md', 'ArrowUp', { altKey: true })
    expect(row('README.md')).toHaveFocus()
    key('README.md', 'Home')
    expect(row('api')).toHaveFocus()
    key('api', 'ArrowUp')
    expect(search()).toHaveFocus()

    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(row('api')).toHaveFocus()
    key('api', 'ArrowDown')
    key('docs', 'Enter')
    await waitFor(() => {
      expect(rows()).toContain('  rate-limits.md')
    })
    key('docs', 'ArrowDown')
    // Nothing to the right of a file.
    key('rate-limits.md', 'ArrowRight')
    expect(row('rate-limits.md')).toHaveFocus()
    key('rate-limits.md', 'Enter')
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: 'docs/rate-limits.md' })
    })
  })

  it('keeps one Tab stop in the tree, on the row last focused', async () => {
    await renderTab()
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    expect(row('api')).toHaveAttribute('tabindex', '0')
    expect(row('docs')).toHaveAttribute('tabindex', '-1')
    act(() => {
      row('docs').focus()
    })
    expect(row('docs')).toHaveAttribute('tabindex', '0')
    expect(row('docs')).toHaveAttribute('aria-selected', 'true')
    expect(row('api')).toHaveAttribute('tabindex', '-1')
  })

  it('finds files anywhere in the workspace, marking the match, and opens one with ↩ or a click', async () => {
    const { invoke, searches } = await renderTab()
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })

    fireEvent.change(search(), { target: { value: 'Throttle' } })

    const results = await screen.findByRole('listbox', { name: 'Matching files' })
    expect(screen.queryByRole('tree')).toBeNull()
    const options = within(results).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['throttles.pyapi', 'test_throttles.pyapi/tests'])
    expect([...results.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['throttle', 'throttle'])
    expect(screen.getByText('Results').parentElement).toHaveTextContent('Results2')
    // Typing waits for a pause before it searches.
    expect(searches).toEqual(['throttle'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(search()).toHaveAttribute('aria-activedescendant', options[0]?.id)

    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: 'api/tests/test_throttles.py' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Browse files' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Browse files', pressed: true })).toBeInTheDocument()
    })
    // The search is still there to come back to.
    expect(search()).toHaveValue('Throttle')
    const first = within(screen.getByRole('listbox')).getByRole('option', { name: /^throttles\.py/ })
    expect(fireEvent.mouseDown(first)).toBe(false)
    fireEvent.click(first)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: 'api/throttles.py' })
    })
  })

  it('clears the search with Esc, back to the tree, and leaves Esc alone with no search', async () => {
    await renderTab()
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    fireEvent.change(search(), { target: { value: 'readme' } })
    await screen.findByRole('listbox')

    expect(fireEvent.keyDown(search(), { key: 'Escape' })).toBe(false)

    expect(search()).toHaveValue('')
    expect(rows()).toHaveLength(3)
    expect(fireEvent.keyDown(search(), { key: 'Escape' })).toBe(true)
    // ↩ with no search does nothing; nor ↑.
    expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(search(), { key: 'ArrowUp' })).toBe(false)
    expect(search()).toHaveValue('')
  })

  it('says when nothing matches, and nothing moves or opens then', async () => {
    const { invoke } = await renderTab()
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    fireEvent.change(search(), { target: { value: 'zzz' } })

    expect(await screen.findByText('No files match.')).toBeInTheDocument()
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.FilesOpen)).toEqual([])
  })

  it('shows the first 200 matches, and how many more there are', async () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 1184 }, (_, index) => file(`tests/test_${String(index)}.py`))
    await renderTab({ tree: { '': [folder('tests')], tests: many } })
    await waitFor(() => {
      expect(rows()).toHaveLength(1)
    })

    fireEvent.change(search(), { target: { value: 'test_' } })

    const results = await screen.findByRole('listbox')
    expect(within(results).getAllByRole('option')).toHaveLength(MAX_SEARCH_RESULTS)
    expect(screen.getByText('1,184 more…')).toBeInTheDocument()
    expect(screen.getByText('Results').parentElement).toHaveTextContent('Results1,384')
  })

  it('shows only the latest search’s answer, however the answers arrive', async () => {
    const answers = new Map<string, (paths: string[]) => void>()
    await renderTab({
      overrides: {
        [CommandName.FilesSearch]: ({ query }) =>
          new Promise((resolve) => {
            answers.set(query, (paths) => {
              resolve({ paths, more: 0 })
            })
          }),
      },
    })
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })

    fireEvent.change(search(), { target: { value: 'api' } })
    await waitFor(() => {
      expect(answers.has('api')).toBe(true)
    })
    fireEvent.change(search(), { target: { value: 'docs' } })
    await waitFor(() => {
      expect(answers.has('docs')).toBe(true)
    })
    await act(async () => {
      answers.get('docs')?.(['docs/rate-limits.md'])
      answers.get('api')?.(['api/views.py'])
      await Promise.resolve()
    })

    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['rate-limits.mddocs'])
  })

  it('says nothing matches when the search fails', async () => {
    await renderTab({ overrides: { [CommandName.FilesSearch]: () => Promise.reject(new Error('gone')) } })
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    fireEvent.change(search(), { target: { value: 'api' } })
    expect(await screen.findByText('No files match.')).toBeInTheDocument()
  })

  it('puts the focus in its search on ⌘F, with the focus in the Files tab, and leaves ⌘F to the window otherwise', async () => {
    await renderTab({ openFiles: { taskId: 't1', paths: ['api/throttles.py'], activePath: null } })
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    act(() => {
      row('api').focus()
    })

    expect(fireEvent.keyDown(row('api'), { key: 'f', metaKey: true })).toBe(false)
    expect(search()).toHaveFocus()

    // With a file showing, ⌘F isn't Browse's.
    fireEvent.click(screen.getByRole('button', { name: /throttles\.py/, pressed: false }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Browse files', pressed: false })).toBeInTheDocument()
    })
    const browse = screen.getByRole('button', { name: 'Browse files' })
    browse.focus()
    expect(fireEvent.keyDown(browse, { key: 'f', metaKey: true })).toBe(true)
    // Nor is any other key.
    fireEvent.click(browse)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Browse files', pressed: true })).toBeInTheDocument()
    })
    expect(fireEvent.keyDown(browse, { key: 'g', metaKey: true })).toBe(true)
  })

  it('lists a folder that shows again when it changes on disk, and no other', async () => {
    const { invoke, emit, tree } = await renderTab({ expanded: ['docs'] })
    await waitFor(() => {
      expect(rows()).toContain('  rate-limits.md')
    })

    tree.docs = [file('docs/rate-limits.md'), file('docs/upgrading.md')]
    act(() => {
      emit({ type: EventType.FolderChanged, taskId: 't1', path: 'docs' })
    })
    await waitFor(() => {
      expect(rows()).toContain('  upgrading.md')
    })

    // Another task's folder, or one that doesn't show, isn't listed.
    act(() => {
      emit({ type: EventType.FolderChanged, taskId: 't2', path: 'docs' })
      emit({ type: EventType.FolderChanged, taskId: 't1', path: 'api' })
    })
    expect(listed(invoke)).toEqual(['', 'docs', 'docs'])

    // A folder that went shows empty, and the agent's deleting it from the root takes it away.
    delete tree.docs
    tree[''] = [folder('api'), file('README.md')]
    act(() => {
      emit({ type: EventType.FolderChanged, taskId: 't1', path: 'docs' })
      emit({ type: EventType.FolderChanged, taskId: 't1', path: '' })
    })
    await waitFor(() => {
      expect(rows()).toEqual(['- api', 'README.md'])
    })
  })

  it('watches the folders that show, and stops when it goes', async () => {
    const { watchedFolders, unmount } = await renderTab({ expanded: ['api'] })
    await waitFor(() => {
      expect(watchedFolders.t1).toEqual(['', 'api'])
    })

    fireEvent.click(row('tests'))
    await waitFor(() => {
      expect(watchedFolders.t1).toEqual(['', 'api', 'api/tests'])
    })

    unmount()
    await waitFor(() => {
      expect(watchedFolders.t1).toEqual([])
    })
  })

  it('keeps an older listing from overwriting a newer one', async () => {
    const answers: ((entries: readonly FolderEntry[]) => void)[] = []
    const { emit } = await renderTab({
      overrides: {
        [CommandName.FilesListFolder]: () =>
          new Promise((resolve) => {
            answers.push((entries) => {
              resolve({ entries })
            })
          }),
      },
    })
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })

    // The root changes while it's still being listed: it's listed again, and that answer comes back first.
    act(() => {
      emit({ type: EventType.FolderChanged, taskId: 't1', path: '' })
    })
    expect(answers).toHaveLength(2)
    await act(async () => {
      answers[1]?.([folder('api'), file('new.md')])
      answers[0]?.([folder('api')])
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(rows()).toEqual(['- api', 'new.md'])
    })
  })

  it('shows a folder it can’t list as empty, and the root’s entries when the open folders can’t be read', async () => {
    await renderTab({
      expanded: ['api'],
      overrides: {
        [CommandName.FilesExpandedFolders]: () => Promise.reject(new Error('gone')),
        [CommandName.FilesListFolder]: ({ path }) =>
          path === 'docs' ? Promise.reject(new Error('gone')) : { entries: sampleTree()[path] ?? null },
      },
    })
    await waitFor(() => {
      expect(rows()).toEqual(['- api', '- docs', 'README.md'])
    })
    fireEvent.click(row('docs'))
    await waitFor(() => {
      expect(rows()).toEqual(['- api', '+ docs', 'README.md'])
    })
  })

  it('gives each row its kind’s icon, and carries on when main can’t watch or remember a folder', async () => {
    await renderTab({
      tree: { ...sampleTree(), '': [folder('api'), file('logo.png'), file('notes.txt'), file('README.md')] },
      overrides: {
        [CommandName.FilesWatchFolders]: () => Promise.reject(new Error('gone')),
        [CommandName.FilesSetFolderExpanded]: () => Promise.reject(new Error('gone')),
      },
    })
    await waitFor(() => {
      expect(rows()).toHaveLength(4)
    })
    fireEvent.click(row('api'))
    await waitFor(() => {
      expect(rows()).toContain('  throttles.py')
    })

    const icon = (name: string): string | null | undefined =>
      row(name).querySelectorAll('svg[data-icon]')[name === 'api' ? 1 : 0]?.getAttribute('data-icon')
    expect(icon('api')).toBe('folder-open')
    expect(icon('tests')).toBe('chevron-right')
    expect(icon('logo.png')).toBe('file-image')
    expect(icon('throttles.py')).toBe('file-code')
    expect(icon('notes.txt')).toBe('file-lines')
  })

  it('says when the workspace has no files yet', async () => {
    await renderTab({ tree: { '': [] } })
    expect(await screen.findByText('No files here yet.')).toBeInTheDocument()
  })
})

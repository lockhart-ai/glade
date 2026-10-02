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
import { moduleClass } from '../components/moduleClass'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge, type FakeHandlers } from '../store/test-bridge'
import styles from './BrowseTab.module.css'
import { FilesTab } from './FilesTab'

const ROOT = sampleWorkspace('w1').rootPath

function folder(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: FolderEntryKind.Folder }
}

function file(path: string, size?: number): FolderEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind: FolderEntryKind.File,
    ...(size === undefined ? {} : { size }),
  }
}

const LONG_NAME = 'test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_clients.py'

/** The made-up workspace of the design, with each file's size in bytes. */
function sizedTree(): Record<string, readonly FolderEntry[]> {
  return {
    '': [
      folder('api'),
      folder('web'),
      file('.gitignore', 348),
      file('docker-compose.yml', 1_100),
      file('Dockerfile', 872),
      file('LICENSE', 0),
      file('README.md', 7_500),
    ],
    api: [folder('api/tests'), file('api/schema.sql', 18_300), file('api/throttles.py', 3_600)],
    'api/tests': [file(`api/tests/${LONG_NAME}`, 6_800), file('api/tests/test_throttles.py')],
    web: [
      file('web/logo.png', 1_400_000),
      file('web/model.bin', 999_950),
      file('web/pnpm-lock.yaml', 212_000),
      file('web/theme.css', 9_700),
    ],
  }
}

const cls = (name: string): string => moduleClass(styles, name)

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
              resolve({ paths, more: 0, sizes: {} })
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

  it('carries on when main can’t watch or remember a folder', async () => {
    await renderTab({
      overrides: {
        [CommandName.FilesWatchFolders]: () => Promise.reject(new Error('gone')),
        [CommandName.FilesSetFolderExpanded]: () => Promise.reject(new Error('gone')),
      },
    })
    await waitFor(() => {
      expect(rows()).toHaveLength(3)
    })
    fireEvent.click(row('api'))
    await waitFor(() => {
      expect(rows()).toContain('  throttles.py')
    })
  })

  it('gives each file its kind’s glyph in its family’s tint, and a folder a filled icon that opens', async () => {
    await renderTab({ tree: sizedTree(), expanded: ['api', 'web'] })
    await waitFor(() => {
      expect(rows()).toHaveLength(14)
    })

    /** A file row's icon: its glyph and family, and what's drawn for it. */
    const icon = (name: string): string => {
      const glyph = row(name).querySelector('[data-glyph]')
      const drawn = [...(glyph?.querySelectorAll('svg') ?? [])].map(
        (svg) => `${svg.getAttribute('data-prefix') ?? 'own'} ${svg.getAttribute('data-icon') ?? ''}`,
      )
      return [glyph?.getAttribute('data-glyph'), glyph?.getAttribute('data-family'), ...drawn].join(' | ')
    }
    expect(icon('throttles.py')).toBe('code | code | far file-code')
    expect(icon('theme.css')).toBe('stylesheet | code | fas hashtag')
    expect(icon('schema.sql')).toBe('database | data | fas database')
    expect(icon('logo.png')).toBe('image | image | far image')
    expect(icon('docker-compose.yml')).toBe('config | config | own braces')
    expect(icon('pnpm-lock.yaml')).toBe('lock | config | fas lock')
    expect(icon('Dockerfile')).toBe('docker | config | fas cube')
    expect(icon('.gitignore')).toBe('dotfile | config | far file')
    expect(icon('README.md')).toBe('docs | docs | far file-lines')
    expect(icon('LICENSE')).toBe('docs | docs | far file-lines')
    expect(icon('model.bin')).toBe('file | docs | far file')
    // Only the dotfile's page has the dot on it.
    expect(row('.gitignore').querySelector('[data-glyph] > span')).not.toBeNull()
    expect(row('model.bin').querySelector('[data-glyph] > span')).toBeNull()

    // A folder: one chevron, which turns rather than changes, and its outline over its solid shape.
    const drawn = (name: string): string[] =>
      [...row(name).querySelectorAll('svg')].map(
        (svg) => `${svg.getAttribute('data-prefix') ?? ''} ${svg.getAttribute('data-icon') ?? ''}`,
      )
    expect(drawn('api')).toEqual(['fas chevron-right', 'fas folder-open', 'far folder-open'])
    expect(drawn('tests')).toEqual(['fas chevron-right', 'fas folder', 'far folder'])
    expect(row('api').querySelector(`.${cls('chevron')}`)).toHaveClass(cls('open'))
    expect(row('tests').querySelector(`.${cls('chevron')}`)).not.toHaveClass(cls('open'))
    // A file keeps the chevron's room, empty, and has no folder's glyph.
    expect(row('README.md').querySelector(`.${cls('chevron')}`)).toBeEmptyDOMElement()
    expect(row('api').querySelector('[data-glyph]')).toBeNull()
  })

  it('shows each file’s size at the far edge, the number and its unit apart, and none for a folder', async () => {
    await renderTab({ tree: sizedTree(), expanded: ['api', 'api/tests', 'web'] })
    await waitFor(() => {
      expect(rows()).toHaveLength(16)
    })

    const size = (name: string): string | null => row(name).querySelector(`.${cls('size')}`)?.textContent ?? null
    expect(size('.gitignore')).toBe('348 B')
    expect(size('Dockerfile')).toBe('872 B')
    expect(size('LICENSE')).toBe('0 B')
    expect(size('docker-compose.yml')).toBe('1.1 KB')
    expect(size('schema.sql')).toBe('18.3 KB')
    expect(size('pnpm-lock.yaml')).toBe('212 KB')
    expect(size('logo.png')).toBe('1.4 MB')
    // What rounds up to 1,000 KB shows as the next unit.
    expect(size('model.bin')).toBe('1.0 MB')
    // The unit has its own slot, after the number, so the digits end on one line whatever the unit.
    const sized = row('schema.sql').querySelector(`.${cls('size')}`)
    expect([...(sized?.children ?? [])].map((part) => part.textContent)).toEqual(['18.3', 'KB'])
    expect(sized?.lastElementChild).toHaveClass(cls('unit'))
    // A folder has none, nor a file whose size main couldn't read; the size is no part of a row's name.
    expect(size('api')).toBeNull()
    expect(size('test_throttles.py')).toBeNull()
    expect(row('schema.sql')).toHaveAccessibleName('schema.sql')
    // The size comes last, after the name and the blue dot.
    expect(row('throttles.py').lastElementChild).toHaveClass(cls('size'))
    expect(within(row('throttles.py')).getByRole('img').nextElementSibling).toHaveClass(cls('size'))
  })

  it('splits a name so it gives way in the middle, with the extension dimmed', async () => {
    await renderTab({ tree: sizedTree(), expanded: ['api', 'api/tests'] })
    await waitFor(() => {
      expect(rows()).toHaveLength(12)
    })

    /** A row's name as it's split: the part that gives way, the end that stays, and the dimmed extension. */
    const split = (name: string): (string | null | undefined)[] => {
      const shown = row(name).querySelector(`.${cls('name')}`)
      return [
        shown?.querySelector(`.${cls('head')}`)?.textContent,
        shown?.querySelector(`.${cls('tail')}`)?.textContent,
        shown?.querySelector(`.${cls('extension')}`)?.textContent,
      ]
    }
    expect(split(LONG_NAME)).toEqual([
      'test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_c',
      'lients.py',
      '.py',
    ])
    expect(split('throttles.py')).toEqual(['throttles', '.py', '.py'])
    expect(split('.gitignore')).toEqual(['.gitignore', '', undefined])
    expect(split('Dockerfile')).toEqual(['Dockerfile', '', undefined])
    expect(split('tests')).toEqual(['tests', '', undefined])
    // Whole, the name reads as it is, and the row is named by it.
    expect(row(LONG_NAME).querySelector(`.${cls('name')}`)).toHaveTextContent(LONG_NAME)
    expect(row(LONG_NAME)).toHaveAttribute('title', `api/tests/${LONG_NAME}`)
  })

  it('draws a guide for each folder a row is in, lit along the way to the selected row, whose folders brighten', async () => {
    await renderTab({ tree: sizedTree(), expanded: ['api', 'api/tests', 'web'] })
    await waitFor(() => {
      expect(rows()).toHaveLength(16)
    })
    const guides = (name: string): (string | null)[] =>
      [...row(name).querySelectorAll('[data-guide]')].map((guide) => guide.getAttribute('data-guide'))
    const lefts = (name: string): string[] =>
      [...row(name).querySelectorAll<HTMLElement>('[data-guide]')].map((guide) => guide.style.left)

    // Nothing selected: every guide is dim, one a level, each under its folder's chevron.
    expect(guides('README.md')).toEqual([])
    expect(guides('throttles.py')).toEqual(['dim'])
    expect(guides('test_throttles.py')).toEqual(['dim', 'dim'])
    expect(lefts('test_throttles.py')).toEqual(['13.5px', '29.5px'])
    expect(row('api')).toHaveClass(cls('folderRow'))
    expect(row('api')).not.toHaveClass(cls('onPath'))
    expect(row('throttles.py')).not.toHaveClass(cls('folderRow'))

    // A file in api selected: api's guide lights wherever it runs, and api brightens; tests and web don't.
    fireEvent.focus(row('throttles.py'))
    expect(row('throttles.py')).toHaveClass(cls('focused'))
    expect(guides('throttles.py')).toEqual(['lit'])
    expect(guides('schema.sql')).toEqual(['lit'])
    expect(guides('test_throttles.py')).toEqual(['lit', 'dim'])
    expect(guides('logo.png')).toEqual(['dim'])
    expect(row('api')).toHaveClass(cls('onPath'))
    expect(row('tests')).not.toHaveClass(cls('onPath'))
    expect(row('web')).not.toHaveClass(cls('onPath'))

    // One level down, both folders on the way are lit.
    fireEvent.focus(row('test_throttles.py'))
    expect(guides('test_throttles.py')).toEqual(['lit', 'lit'])
    expect(guides('throttles.py')).toEqual(['lit'])
    expect(row('api')).toHaveClass(cls('onPath'))
    expect(row('tests')).toHaveClass(cls('onPath'))

    // A folder selected is not on its own path; the folders above it are.
    fireEvent.focus(row('tests'))
    expect(row('tests')).not.toHaveClass(cls('onPath'))
    expect(row('api')).toHaveClass(cls('onPath'))
    expect(guides('test_throttles.py')).toEqual(['lit', 'dim'])
  })

  it('gives a search’s results the same icons and sizes', async () => {
    await renderTab({ tree: sizedTree() })
    await waitFor(() => {
      expect(rows()).toHaveLength(7)
    })

    fireEvent.change(search(), { target: { value: 'e' } })
    const results = await screen.findByRole('listbox', { name: 'Matching files' })
    const option = (name: string): HTMLElement =>
      within(results)
        .getAllByRole('option')
        .find((found) => found.getAttribute('title')?.endsWith(name)) ?? results
    const glyph = (name: string): string | null | undefined =>
      option(name).querySelector('[data-glyph]')?.getAttribute('data-glyph')
    const size = (name: string): string | null => option(name).querySelector(`.${cls('size')}`)?.textContent ?? null

    expect(glyph('schema.sql')).toBe('database')
    expect(glyph('theme.css')).toBe('stylesheet')
    expect(glyph('Dockerfile')).toBe('docker')
    expect(glyph('.gitignore')).toBe('dotfile')
    expect(glyph('docker-compose.yml')).toBe('config')
    expect(size('schema.sql')).toBe('18.3 KB')
    expect(size('Dockerfile')).toBe('872 B')
    expect(size(LONG_NAME)).toBe('6.8 KB')
    // A file whose size main couldn't read has none; the size comes after the folder.
    expect(size('test_throttles.py')).toBeNull()
    expect(option('schema.sql')).toHaveTextContent('schema.sqlapi18.3 KB')
    expect(option('schema.sql').lastElementChild).toHaveClass(cls('size'))
  })

  it('says when the workspace has no files yet', async () => {
    await renderTab({ tree: { '': [] } })
    expect(await screen.findByText('No files here yet.')).toBeInTheDocument()
  })
})

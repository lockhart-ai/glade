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
  type TaskCommit,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleCommit,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { commitFileKey } from '../../shared/files'
import { colors } from '../tokens'
import { absolutePath, FilesTab, type FileLineFocus } from './FilesTab'

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
    progressSummary: null,
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
  readonly commits?: TaskCommit[]
}

async function renderTab({
  toolEvents = EVENTS,
  openFiles,
  files = FILES,
  overrides = {},
  focus,
  commits = [],
}: Setup = {}): Promise<FakeBridge & { store: GladeStore; opened: string[]; copied: string[]; revealed: string[] }> {
  const opened: string[] = []
  const copied: string[] = []
  const revealed: string[] = []
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
      copied,
      revealed,
      commits,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <FilesTab taskId="t1" rootPath={ROOT} focus={focus ?? null} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, opened, copied, revealed }
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

describe('a file tab’s context menu', () => {
  async function choose(name: string, label: string): Promise<void> {
    const tab = within(openTabs()).getByRole('button', {
      name: new RegExp(`^(Changed by the agent)?\\s*${name}$`),
    }).parentElement
    fireEvent.contextMenu(tab ?? document.body)
    await act(() => Promise.resolve())
    // The label, then its shortcut if any: "Close" isn't "Close others".
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}(?![ a-z])`) }))
    await act(() => Promise.resolve())
  }

  function tabNames(): string[] {
    return within(openTabs())
      .queryAllByRole('button')
      .filter((button) => button.hasAttribute('aria-pressed'))
      .map((button) => button.textContent)
  }

  it('has the reference’s items, and opens on ⇧F10 on a tab', async () => {
    await renderTab({ openFiles: OPEN })

    const select = within(openTabs()).getByRole('button', { name: /^(Changed by the agent)?\s*throttles\.py$/ })
    fireEvent.keyDown(select, { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Close⌘W',
      'Close others',
      'Close all',
      'Open in editor⌘⇧E',
      'Reveal in Finder',
      'Copy path',
      'Copy relative path',
    ])
  })

  it('copies the file’s path, whole or relative, opens it in the editor and shows it in Finder', async () => {
    const { copied, opened, revealed } = await renderTab({ openFiles: OPEN })

    await choose('throttles.py', 'Copy path')
    await choose('throttles.py', 'Copy relative path')
    await choose('throttles.py', 'Open in editor')
    await choose('throttles.py', 'Reveal in Finder')

    expect(copied).toEqual([`${ROOT}/api/throttles.py`, 'api/throttles.py'])
    expect(opened).toEqual(['api/throttles.py'])
    expect(revealed).toEqual(['api/throttles.py'])
  })

  it('closes the tab, the others, or all of them', async () => {
    await renderTab({ openFiles: OPEN })

    await choose('settings.py', 'Close')
    await vi.waitFor(() => {
      expect(tabNames()).toEqual(['rate-limits.md', 'throttles.py'])
    })

    await choose('throttles.py', 'Close others')
    await vi.waitFor(() => {
      expect(tabNames()).toEqual(['throttles.py'])
    })

    await choose('throttles.py', 'Close all')
    await vi.waitFor(() => {
      expect(tabNames()).toEqual([])
    })
  })

  it('shows a toast when Finder can’t show the file', async () => {
    await renderTab({
      openFiles: OPEN,
      overrides: { [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file there')) },
    })

    await choose('throttles.py', 'Reveal in Finder')

    expect(await screen.findByText('No file there')).toBeInTheDocument()
  })
})

describe('a file as a commit left it', () => {
  const COMMIT = sampleCommit('abc1234', 't1', { subject: 'Rename the upgrade guide' })
  const KEY = commitFileKey({ commitId: COMMIT.id, path: 'docs/upgrading.md' })
  const GONE = commitFileKey({ commitId: 'forgotten', path: 'docs/old.md' })
  const WITH_COMMIT: OpenFiles = { taskId: 't1', paths: ['api/throttles.py', KEY, GONE], activePath: KEY }
  const GUIDE = '# Upgrading\n\nRun the migrations first.\n'

  async function renderCommitFile(files: Readonly<Record<string, FileContent>> = {}) {
    return renderTab({
      openFiles: WITH_COMMIT,
      commits: [COMMIT],
      files: {
        ...FILES,
        [KEY]: { kind: FileContentKind.Text, text: GUIDE, truncated: false, size: GUIDE.length },
        ...files,
      },
    })
  }

  it('shows read-only, named by its path in the commit and labelled with the hash, with no Open in editor', async () => {
    const { opened } = await renderCommitFile()

    const tab = within(openTabs()).getByRole('button', { name: 'upgrading.mdabc1234', pressed: true })
    expect(tab.parentElement).toHaveAttribute('title', 'docs/upgrading.md (abc1234)')
    expect(await screen.findByText('Run the migrations first.')).toBeInTheDocument()
    expect(screen.getByText('docs/upgrading.md', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('As of abc1234 · read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'docs/upgrading.md contents' })).toBeInTheDocument()

    // ⌘⇧E has no file to open.
    fireEvent.keyDown(window, { key: 'E', code: 'KeyE', metaKey: true, shiftKey: true })
    await act(() => Promise.resolve())
    expect(opened).toEqual([])
  })

  it('says so when the task no longer has the commit, or its file can’t be read, or isn’t text', async () => {
    await renderCommitFile({ [KEY]: { kind: FileContentKind.Binary, size: 2048 } })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This file isn’t text (2 KB), so it can’t be shown here.',
    )
    expect(screen.getByRole('status')).not.toHaveTextContent('editor')

    fireEvent.click(within(openTabs()).getByRole('button', { name: 'old.md', pressed: false }))
    expect(await screen.findByText('This commit’s file can’t be read any more.')).toBeInTheDocument()
    expect(screen.getByText('As a commit left it · read-only')).toBeInTheDocument()
    expect(within(openTabs()).getByRole('button', { name: 'old.md' }).parentElement).toHaveAttribute(
      'title',
      'docs/old.md (a commit)',
    )
  })

  it('has only the menu items that apply to a file that’s only in git, and copies its path in the commit', async () => {
    const { copied } = await renderCommitFile()

    const tab = within(openTabs()).getByRole('button', { name: 'upgrading.mdabc1234' }).parentElement
    fireEvent.contextMenu(tab ?? document.body)
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Close⌘W',
      'Close others',
      'Close all',
      'Copy relative path',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy relative path' }))
    await act(() => Promise.resolve())
    expect(copied).toEqual(['docs/upgrading.md'])
  })
})

describe('absolutePath', () => {
  it('joins the root and the relative path, whether the root ends in a slash or not', () => {
    expect(absolutePath('/code/acme-api', 'src/date.ts')).toBe('/code/acme-api/src/date.ts')
    expect(absolutePath('/code/acme-api/', 'src/date.ts')).toBe('/code/acme-api/src/date.ts')
  })
})

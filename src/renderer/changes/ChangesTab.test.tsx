// The Changes tab (docs/design/html/24-changes.html), in the right panel over a fake main: the commits a task made,
// a commit's files, and a file opened in Files.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  CommitFileStatus,
  FileContentKind,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type CommitFiles,
  type FileContent,
  type TaskCommit,
  type ToolEvent,
} from '../../shared/domain'
import { commitFileKey } from '../../shared/files'
import { ToastProvider } from '../components'
import { TaskPanel } from '../right-panel/TaskPanel'
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
  type FakeMain,
} from '../store/test-bridge'

const NOW = new Date(2026, 8, 25, 13, 30).getTime()
const at = (minute: number): number => new Date(2026, 8, 25, 13, minute).getTime()

/** The design's commits, newest first: a merge, a subagent's rename, the release script's bump, the fix. */
const COMMITS: TaskCommit[] = [
  sampleCommit('e5f6a7b', 't1', {
    subject: 'Merge the upgrade guide',
    branch: 'main',
    merge: true,
    committedAt: at(28),
    additions: 1,
    deletions: 0,
  }),
  sampleCommit('c3d4e5f', 't1', {
    subject: 'Rename the upgrade guide and add the logo',
    branch: 'docs/upgrade',
    committedAt: at(26),
    repoPath: '/code/acme-api-docs',
    subagentToolUseId: 'toolu_docs',
  }),
  sampleCommit('b2c3d4e', 't1', { subject: 'Bump the version to 2.4.1', branch: 'main', committedAt: at(20) }),
  sampleCommit('a1b2c3d', 't1', { subject: 'Fix the UTC date test', branch: 'main', committedAt: at(18) }),
]

const RENAME_FILES: CommitFiles = {
  files: [
    {
      path: 'docs/upgrading.md',
      oldPath: 'docs/upgrade.md',
      status: CommitFileStatus.Renamed,
      additions: 1,
      deletions: 0,
    },
    { path: 'docs/logo.png', oldPath: null, status: CommitFileStatus.Added, additions: null, deletions: null },
  ],
  total: 2,
}

const FIX_FILES: CommitFiles = {
  files: [
    { path: 'src/date.ts', oldPath: null, status: CommitFileStatus.Modified, additions: 1, deletions: 1 },
    { path: 'test/date.test.ts', oldPath: null, status: CommitFileStatus.Deleted, additions: 0, deletions: 12 },
  ],
  total: 114,
}

const DOCS_AGENT: ToolEvent = {
  id: 'e-docs',
  taskId: 't1',
  turn: 1,
  createdAt: at(24),
  kind: ToolEventKind.ToolCall,
  name: 'Agent',
  input: { description: 'Update the upgrade guide', subagent_type: 'general-purpose' },
  output: 'Done.',
  state: ToolCallState.Done,
  finishedAt: at(26),
  toolUseId: 'toolu_docs',
  parentToolUseId: null,
  progressSummary: null,
}

const GUIDE: FileContent = { kind: FileContentKind.Text, text: '# Upgrading\n', truncated: false, size: 12 }
const DATE: FileContent = { kind: FileContentKind.Text, text: 'export const header = 2\n', truncated: false, size: 24 }

interface Setup extends Partial<FakeMain> {
  readonly handlers?: Partial<FakeHandlers>
}

async function renderChanges({ handlers = {}, ...main }: Setup = {}): Promise<FakeBridge & { store: GladeStore }> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
        { key: UiStateKey.RightPanelTab, value: 'changes' },
      ],
      toolEvents: [DOCS_AGENT],
      commits: COMMITS,
      commitFiles: { [COMMITS[1]?.id ?? '']: RENAME_FILES, [COMMITS[3]?.id ?? '']: FIX_FILES },
      files: {
        'src/date.ts': DATE,
        [commitFileKey({ commitId: COMMITS[1]?.id ?? '', path: 'docs/upgrading.md' })]: GUIDE,
      },
      currentCommitFiles: { [`${COMMITS[3]?.id ?? ''}:src/date.ts`]: 'src/date.ts' },
      ...main,
    },
    handlers,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <TaskPanel />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function tab(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name })
}

function row(subject: string): HTMLElement {
  return screen.getByRole('group', { name: subject })
}

/** A commit's header: the button that opens and closes it. */
function header(subject: string): HTMLElement {
  const [button] = within(row(subject)).getAllByRole('button')
  if (button === undefined) throw new Error(`No header for ${subject}`)
  return button
}

async function expand(subject: string): Promise<void> {
  fireEvent.click(header(subject))
  await act(() => Promise.resolve())
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Changes tab', () => {
  it('lists the task’s commits newest first: hash, message, lines, branch, when, and the subagent that made one', async () => {
    await renderChanges()

    expect(tab(/^Changes/)).toHaveTextContent('Changes 4')
    expect(tab(/^Changes/)).toHaveAttribute('aria-selected', 'true')
    const rows = screen.getAllByRole('group').filter((group) => group.hasAttribute('data-hash'))
    expect(rows.map((group) => group.getAttribute('aria-label'))).toEqual(COMMITS.map(({ subject }) => subject))
    expect(row('Merge the upgrade guide')).toHaveTextContent('e5f6a7bMerge the upgrade guide+1−0main · 2m ago · merge')
    expect(row('Rename the upgrade guide and add the logo')).toHaveTextContent(
      'c3d4e5fRename the upgrade guide and add the logo+12−3docs/upgrade · 4m ago' + 'Update the upgrade guide',
    )
    expect(within(row('Fix the UTC date test')).queryByTitle(/Made by the subagent/)).not.toBeInTheDocument()
    expect(
      within(row('Rename the upgrade guide and add the logo')).getByTitle(
        'Made by the subagent “Update the upgrade guide”',
      ),
    ).toBeInTheDocument()
    expect(header('Fix the UTC date test')).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a commit to its files, read as it opens and kept, with a capped list’s count, and closes it', async () => {
    const { invoke } = await renderChanges()

    await expand('Rename the upgrade guide and add the logo')
    const files = await screen.findByRole('list', { name: 'Files in c3d4e5f' })
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Rdocs/upgrade.md → docs/upgrading.md+1−0', 'Adocs/logo.pngbinary'])
    expect(within(files).getByLabelText('Renamed')).toHaveTextContent('R')
    expect(header('Rename the upgrade guide and add the logo')).toHaveAttribute('aria-expanded', 'true')

    await expand('Fix the UTC date test')
    expect(await screen.findByText('and 112 more files')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Files in a1b2c3d' })).getByLabelText('Deleted')).toBeInTheDocument()

    // Closed and opened again, it has its files already.
    await expand('Rename the upgrade guide and add the logo')
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(screen.queryByRole('list', { name: 'Files in c3d4e5f' })).not.toBeInTheDocument()
    await expand('Rename the upgrade guide and add the logo')
    expect(screen.getByRole('list', { name: 'Files in c3d4e5f' })).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.ChangesFiles)).toHaveLength(2)
  })

  it('says it’s reading the files, and why they can’t be read, and tries again when opened again', async () => {
    let fail = true
    const { invoke } = await renderChanges({
      handlers: {
        [CommandName.ChangesFiles]: () =>
          fail
            ? refuse(bridgeError(BridgeErrorCode.Internal, "Couldn't read the files of commit b2c3d4e"))
            : Promise.resolve({ files: { files: [], total: 0 } }),
      },
    })

    await expand('Bump the version to 2.4.1')
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Its files can’t be read: Couldn't read the files of commit b2c3d4e",
    )
    fail = false
    await expand('Bump the version to 2.4.1')
    await act(() => vi.advanceTimersByTimeAsync(500))
    await expand('Bump the version to 2.4.1')
    expect(await screen.findByRole('list', { name: 'Files in b2c3d4e' })).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.ChangesFiles)).toHaveLength(2)
  })

  it('says it’s reading a commit’s files until they come, and why when the failure isn’t the bridge’s', async () => {
    let answer: (files: CommitFiles) => void = () => undefined
    await renderChanges({
      handlers: {
        [CommandName.ChangesFiles]: ({ id }) =>
          id === COMMITS[0]?.id
            ? Promise.reject(new Error('The window closed'))
            : new Promise((resolve) => {
                answer = (files) => {
                  resolve({ files })
                }
              }),
      },
    })

    await expand('Fix the UTC date test')
    expect(screen.getByText('Reading its files…')).toBeInTheDocument()
    await act(async () => {
      answer(FIX_FILES)
      await Promise.resolve()
    })
    expect(screen.queryByText('Reading its files…')).not.toBeInTheDocument()

    await expand('Merge the upgrade guide')
    expect(await screen.findByText('Its files can’t be read: Error: The window closed')).toBeInTheDocument()
  })

  it('opens a file that’s still there in Files as it is now, and one that’s gone as its commit left it', async () => {
    await renderChanges()

    await expand('Fix the UTC date test')
    fireEvent.click(await screen.findByRole('button', { name: /src\/date\.ts/ }))
    expect(await screen.findByText('export const header = 2')).toBeInTheDocument()
    expect(tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Open in editor' })).toBeInTheDocument()

    fireEvent.click(tab(/^Changes/))
    await act(() => Promise.resolve())
    await expand('Rename the upgrade guide and add the logo')
    fireEvent.click(await screen.findByRole('button', { name: /docs\/upgrading\.md/ }))
    expect(await screen.findByText('As of c3d4e5f · read-only')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'docs/upgrading.md contents' })).toHaveTextContent('# Upgrading')
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument()
    expect(tab(/^Files/)).toHaveTextContent('Files 2')
  })

  it('follows the task’s commits as they’re made, and shows only the selected task’s', async () => {
    const { emit, store } = await renderChanges({
      commits: [...COMMITS.slice(3), sampleCommit('f0f0f0f', 't2', { subject: 'Tidy the README' })],
    })
    expect(tab(/^Changes/)).toHaveTextContent('Changes 1')

    act(() => {
      emit({ type: EventType.CommitsChanged, taskId: 't1', commits: COMMITS })
    })
    expect(tab(/^Changes/)).toHaveTextContent('Changes 4')
    expect(row('Merge the upgrade guide')).toBeInTheDocument()

    await act(() => store.getState().selectTask('t2'))
    expect(tab(/^Changes/)).toHaveTextContent('Changes 1')
    expect(row('Tidy the README')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Merge the upgrade guide' })).not.toBeInTheDocument()
  })
})

describe('the Changes tab without commits', () => {
  it('says the task has made none yet', async () => {
    await renderChanges({ commits: [] })
    expect(tab(/^Changes/)).toHaveTextContent(/^Changes$/)
    expect(await screen.findByText('No commits in this task yet.')).toBeInTheDocument()
  })

  it('says the workspace isn’t a git repository', async () => {
    await renderChanges({ commits: [], inRepository: false })
    expect(await screen.findByText('This workspace isn’t a git repository.')).toBeInTheDocument()
    expect(screen.getByText('Commits the agent makes in a repository inside it show here.')).toBeInTheDocument()
  })

  it('says none yet when it can’t tell, and asks nothing once there are commits', async () => {
    const { invoke, emit } = await renderChanges({
      commits: [],
      handlers: { [CommandName.ChangesRepository]: () => Promise.reject(new Error('The window closed')) },
    })
    expect(await screen.findByText('No commits in this task yet.')).toBeInTheDocument()

    act(() => {
      emit({ type: EventType.CommitsChanged, taskId: 't1', commits: COMMITS })
    })
    expect(row('Fix the UTC date test')).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.ChangesRepository)).toHaveLength(1)
  })

  it('shows nothing without a task', async () => {
    await renderChanges({
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.RightPanelTab, value: 'changes' },
      ],
    })
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement()
  })
})

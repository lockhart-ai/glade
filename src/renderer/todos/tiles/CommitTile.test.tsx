// A commit's tile in the todo hub (#499; docs/design/html/48-todo-hub-tiles.html): it opens in place to its branch, the
// subagent that made it and its files, as its row in the Changes tab does, and a file opens in the Files tab.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../../shared/bridge'
import { CommitFileStatus, type CommitFile, type CommitFiles, type TaskCommit } from '../../../shared/domain'
import { commitFileKey } from '../../../shared/files'
import { ChildKind, commitChildKey } from '../../../shared/todoHub'
import { activePanelTab, PanelTab } from '../../right-panel/panelModel'
import { refuse, type FakeHandlers, type FakeMain } from '../../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../../store/test-wrapper'
import { HUB_NOW, hubAgent, hubCommit, hubMain, type HubTask } from '../test-hub'
import { ChildTile } from './ChildTile'
import styles from './Tile.module.css'
import partStyles from './TileParts.module.css'

/** A commit's tile over a fake main with the hub on, hydrated; `more` is the fake main's other data. */
async function renderTile(
  task: HubTask,
  commit: TaskCommit,
  more: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<StoreWrapper> {
  const wrapper = storeWrapper({ ...hubMain(task), ...more }, overrides)
  await act(() => wrapper.store.getState().hydrate())
  render(<ChildTile taskId="t1" kind={ChildKind.Commit} childKey={commitChildKey(commit)} />, {
    wrapper: wrapper.wrapper,
  })
  return wrapper
}

function tile(): HTMLElement {
  return screen.getByRole('group', { name: /^Change: / })
}

/** Opens the tile, and waits for main's answer about its files. */
async function open(): Promise<void> {
  fireEvent.click(tile())
  await act(() => Promise.resolve())
}

function file(path: string, fields: Partial<CommitFile> = {}): CommitFile {
  return { path, oldPath: null, status: CommitFileStatus.Modified, additions: 6, deletions: 1, ...fields }
}

/** The commit in 48-todo-hub-tiles.html, which the subagent `soak-login` made. */
const REPEAT = hubCommit('e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', 'Let the login test repeat', 4, {
  branch: 'fix/session-race',
  additions: 6,
  deletions: 1,
  subagentToolUseId: 'soak',
})
const REPEAT_FILES: CommitFiles = { files: [file('tests/conftest.py')], total: 1 }
const SOAK = hubAgent('soak', 'soak-login', 9)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a commit’s tile', () => {
  it('says a merge commit is one, after its subject', async () => {
    const merge = hubCommit('aa11'.repeat(10), 'Merge the upgrade guide', 3, {
      merge: true,
      additions: 1,
      deletions: 0,
    })
    await renderTile({ commits: [merge] }, merge)
    expect(tile()).toHaveTextContent(/^aa11aa1Merge the upgrade guidemerge\+1 −0 · 3m$/)
    expect(screen.getByText('merge')).toHaveClass(styles.tag ?? '')
  })

  it('opens in place to its branch, the subagent that made it and its files, and closes on the next click', async () => {
    await renderTile({ commits: [REPEAT], toolEvents: [SOAK] }, REPEAT, { commitFiles: { [REPEAT.id]: REPEAT_FILES } })
    expect(tile()).toHaveTextContent(/^e7f8a9bLet the login test repeat\+6 −1 · 4m$/)

    await open()

    expect(tile()).toHaveTextContent(
      /^e7f8a9bLet the login test repeat\+6 −1 · 4mfix\/session-racesoak-loginMtests\/conftest\.py\+6−1$/,
    )
    const tag = screen.getByTitle('Made by the subagent “soak-login”')
    expect(tag).toHaveClass(partStyles.by ?? '')
    const files = screen.getByRole('list', { name: 'Files in e7f8a9b' })
    expect(within(files).getByLabelText('Modified')).toHaveTextContent('M')
    // In the tile's own box, on inner-2: nothing in a card is black.
    expect(files.parentElement).toHaveClass(partStyles.well ?? '', partStyles.files ?? '')

    fireEvent.click(tile())
    expect(screen.queryByRole('list', { name: 'Files in e7f8a9b' })).toBeNull()
    expect(screen.queryByText('fix/session-race')).toBeNull()
  })

  it('goes to the subagent’s tab in the Agents tab from its name, and stays open', async () => {
    const { store, fake } = await renderTile({ commits: [REPEAT], toolEvents: [SOAK] }, REPEAT, {
      commitFiles: { [REPEAT.id]: REPEAT_FILES },
    })
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'soak-login' }))
    await act(() => Promise.resolve())

    expect(store.getState().agentTabs).toEqual({ t1: 'soak' })
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Agents)
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.AgentsSetTab, { taskId: 't1', agentId: 'soak' })
    // The click was the name's own: the tile didn't close.
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()
  })

  it('opens with ↵ while it has the focus', async () => {
    await renderTile({ commits: [REPEAT] }, REPEAT, { commitFiles: { [REPEAT.id]: REPEAT_FILES } })
    fireEvent.keyDown(tile(), { key: 'Enter' })
    await act(() => Promise.resolve())
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()
  })

  it('has no tag for a commit the task’s own agent made, and says a detached HEAD', async () => {
    const own = hubCommit('bb22'.repeat(10), 'Bump the version', 2, { branch: null })
    await renderTile({ commits: [own], toolEvents: [SOAK] }, own, { commitFiles: { [own.id]: REPEAT_FILES } })
    await open()
    expect(tile()).toHaveTextContent(/2mdetachedMtests\/conftest\.py/)
    expect(screen.queryByTitle(/^Made by/)).toBeNull()
  })

  it('says a subagent made it even when the tool log hasn’t got that subagent', async () => {
    await renderTile({ commits: [REPEAT] }, REPEAT, { commitFiles: { [REPEAT.id]: REPEAT_FILES } })
    await open()
    expect(screen.getByTitle('Made by the subagent “Subagent”')).toBeInTheDocument()
    // It has no tab to go to, so its name is plain text.
    expect(screen.queryByRole('button', { name: 'Subagent' })).toBeNull()
  })

  it('says it’s reading its files until main answers, and reads them once however often it’s opened', async () => {
    let answer: (files: CommitFiles) => void = () => undefined
    const read = new Promise<CommitFiles>((resolve) => {
      answer = resolve
    })
    const { fake } = await renderTile(
      { commits: [REPEAT] },
      REPEAT,
      {},
      { [CommandName.ChangesFiles]: async () => ({ files: await read }) },
    )

    fireEvent.click(tile())
    expect(tile()).toHaveTextContent(/fix\/session-raceSubagentReading its files…$/)
    // Closed and opened again while it reads: it doesn't ask twice.
    fireEvent.click(tile())
    fireEvent.click(tile())
    await act(async () => {
      answer(REPEAT_FILES)
      await read
    })
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()

    fireEvent.click(tile())
    fireEvent.click(tile())
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.ChangesFiles)).toHaveLength(1)
  })

  it('says why its files can’t be read, and reads them again the next time it’s opened', async () => {
    let readable = false
    const { fake } = await renderTile(
      { commits: [REPEAT] },
      REPEAT,
      {},
      {
        [CommandName.ChangesFiles]: () =>
          readable
            ? { files: REPEAT_FILES }
            : refuse(bridgeError(BridgeErrorCode.Internal, 'The repository has no such commit')),
      },
    )

    await open()
    expect(screen.getByRole('status')).toHaveTextContent('Its files can’t be read: The repository has no such commit')
    expect(screen.getByText('fix/session-race')).toBeInTheDocument()

    // Its repository has the commit again by the time the tile is opened again.
    fireEvent.click(tile())
    readable = true
    await open()
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.ChangesFiles)).toHaveLength(2)
  })

  it('says so when reading its files fails for a reason main doesn’t name', async () => {
    await renderTile(
      { commits: [REPEAT] },
      REPEAT,
      {},
      { [CommandName.ChangesFiles]: () => Promise.reject(new Error('git exited with 128')) },
    )
    await open()
    expect(screen.getByRole('status')).toHaveTextContent('Its files can’t be read: Error: git exited with 128')
  })

  it('opens a file in the Files tab: as it is now when it’s still there, else as the commit left it', async () => {
    const files: CommitFiles = { files: [file('tests/conftest.py'), file('tests/old.py')], total: 2 }
    const { store } = await renderTile({ commits: [REPEAT] }, REPEAT, {
      commitFiles: { [REPEAT.id]: files },
      currentCommitFiles: { [`${REPEAT.id}:tests/conftest.py`]: 'tests/conftest.py' },
    })
    await open()

    fireEvent.click(screen.getByRole('button', { name: /tests\/conftest\.py/ }))
    await act(() => Promise.resolve())
    expect(store.getState().openFiles.t1?.activePath).toBe('tests/conftest.py')
    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)

    fireEvent.click(screen.getByRole('button', { name: /tests\/old\.py/ }))
    await act(() => Promise.resolve())
    expect(store.getState().openFiles.t1?.activePath).toBe(commitFileKey({ commitId: REPEAT.id, path: 'tests/old.py' }))
    // A click on a file, or beside one, is no click on the tile: it stays open.
    fireEvent.click(screen.getByRole('list', { name: 'Files in e7f8a9b' }))
    fireEvent.click(screen.getByText('fix/session-race'))
    expect(screen.getByRole('list', { name: 'Files in e7f8a9b' })).toBeInTheDocument()
  })

  it('shows a toast when a file can’t be opened', async () => {
    await renderTile(
      { commits: [REPEAT] },
      REPEAT,
      { commitFiles: { [REPEAT.id]: REPEAT_FILES } },
      {
        [CommandName.ChangesOpenFile]: () => Promise.reject(new Error('The commit is gone')),
      },
    )
    await open()
    fireEvent.click(screen.getByRole('button', { name: /tests\/conftest\.py/ }))
    expect(await screen.findByText(/The commit is gone/)).toBeInTheDocument()
  })

  it('shows a rename from its old path, a binary file with no lines, and each status by its letter', async () => {
    const files: CommitFiles = {
      files: [
        file('docs/upgrading.md', {
          oldPath: 'docs/upgrade.md',
          status: CommitFileStatus.Renamed,
          additions: 1,
          deletions: 0,
        }),
        file('docs/logo.png', { status: CommitFileStatus.Added, additions: null, deletions: null }),
        file('docs/old.md', { status: CommitFileStatus.Deleted, additions: 0, deletions: 40 }),
      ],
      total: 3,
    }
    await renderTile({ commits: [REPEAT] }, REPEAT, { commitFiles: { [REPEAT.id]: files } })
    await open()

    const rows = within(screen.getByRole('list', { name: 'Files in e7f8a9b' })).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Rdocs/upgrade.md → docs/upgrading.md+1−0',
      'Adocs/logo.pngbinary',
      'Ddocs/old.md+0−40',
    ])
    expect(rows[0]).toHaveAttribute('title', 'docs/upgrade.md → docs/upgrading.md')
    expect(screen.getByLabelText('Renamed')).toHaveTextContent('R')
  })

  it('lists a commit’s 200 files, a row each, and says how many more there are past the cap', async () => {
    const many: CommitFiles = {
      files: Array.from({ length: 200 }, (_, index) => file(`src/generated/model-${String(index)}.ts`)),
      total: 1612,
    }
    const { store } = await renderTile({ commits: [REPEAT] }, REPEAT, { commitFiles: { [REPEAT.id]: many } })
    await open()

    const list = screen.getByRole('list', { name: 'Files in e7f8a9b' })
    expect(within(list).getAllByRole('button')).toHaveLength(200)
    expect(tile()).toHaveTextContent(/and 1,412 more files$/)
    // The last of them opens like the first.
    fireEvent.click(screen.getByRole('button', { name: /model-199\.ts/ }))
    await act(() => Promise.resolve())
    expect(store.getState().openFiles.t1?.activePath).toBe(
      commitFileKey({ commitId: REPEAT.id, path: 'src/generated/model-199.ts' }),
    )
  })
})

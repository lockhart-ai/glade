import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  FileInfoKind,
  ToolEventKind,
  UiStateKey,
  type Artifact,
  type FileInfo,
  type ToolEvent,
} from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from '../store/test-bridge'
import { ArtifactsTab } from './ArtifactsTab'

const MINUTE = 60_000
const NOW = 1_000 * MINUTE

function artifact(path: string, title: string, minutesAgo: number): Artifact {
  const at = NOW - minutesAgo * MINUTE
  return { taskId: 't1', path, title, addedAt: at, updatedAt: at }
}

const NOTES = artifact('docs/releases/2.4.md', 'Release notes 2.4', 12)
const GUIDE = artifact('docs/releases/2.4-upgrade.md', 'Upgrade guide', 8)
const EMAIL = artifact('out/announcement-2.4.txt', 'Announcement email', 6)

const INFO: Readonly<Record<string, FileInfo>> = {
  [NOTES.path]: { kind: FileInfoKind.Text, lines: 128, modifiedAt: NOW - 12 * MINUTE },
  [GUIDE.path]: { kind: FileInfoKind.Text, lines: 34, modifiedAt: NOW - 8 * MINUTE },
  [EMAIL.path]: { kind: FileInfoKind.Text, lines: 22, modifiedAt: NOW - 6 * MINUTE },
}

interface Setup {
  readonly artifacts?: readonly Artifact[]
  readonly fileInfo?: Readonly<Record<string, FileInfo>>
  readonly overrides?: Partial<FakeHandlers>
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain & { copied: string[]; revealed: string[] }
}

async function renderTab({
  artifacts = [NOTES, GUIDE, EMAIL],
  fileInfo = INFO,
  overrides,
}: Setup = {}): Promise<Rendered> {
  const main = {
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
      { key: UiStateKey.RightPanelTab, value: 'artifacts' },
    ],
    artifacts,
    fileInfo,
    copied: [],
    revealed: [],
  }
  const fake = fakeBridge(main, overrides)
  const store = createGladeStore(fake.bridge)
  await act(async () => {
    await store.getState().hydrate()
    await store.getState().loadHistory('t1')
  })
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <ArtifactsTab taskId="t1" now={NOW} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, main }
}

function card(title: string): HTMLElement {
  return screen.getByRole('listitem', { name: title })
}

function button(title: string, name: string): HTMLElement {
  return within(card(title)).getByRole('button', { name })
}

describe('ArtifactsTab', () => {
  it('shows a card per artifact, in order, with its title, path, and type · lines · age', async () => {
    await renderTab()

    const cards = within(screen.getByRole('list', { name: 'Artifacts' })).getAllByRole('listitem')
    expect(cards.map((element) => element.getAttribute('aria-label'))).toEqual([
      'Release notes 2.4',
      'Upgrade guide',
      'Announcement email',
    ])
    await waitFor(() => {
      expect(card('Release notes 2.4')).toHaveTextContent(
        'Release notes 2.4docs/releases/2.4.mdMarkdown · 128 lines · 12m ago',
      )
    })
    expect(card('Announcement email')).toHaveTextContent('Text · 22 lines · 6m ago')
    expect(
      within(card('Upgrade guide'))
        .getAllByRole('button')
        .map((element) => element.textContent),
    ).toEqual(['Open', 'Copy', 'Reveal in folder'])
  })

  it('says so when the agent has declared none', async () => {
    await renderTab({ artifacts: [] })

    expect(screen.getByText('No artifacts yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('opens an artifact in the Files tab', async () => {
    const { store, invoke } = await renderTab()
    await waitFor(() => {
      expect(button('Upgrade guide', 'Open')).toBeEnabled()
    })

    fireEvent.click(button('Upgrade guide', 'Open'))

    await waitFor(() => {
      expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: GUIDE.path })
    expect(store.getState().openFiles.t1?.activePath).toBe(GUIDE.path)
  })

  it('copies an artifact’s contents and reveals it in its folder, through main', async () => {
    const { main } = await renderTab()
    await waitFor(() => {
      expect(button('Release notes 2.4', 'Copy')).toBeEnabled()
    })

    fireEvent.click(button('Release notes 2.4', 'Copy'))
    fireEvent.click(button('Announcement email', 'Reveal in folder'))

    await waitFor(() => {
      expect(main.revealed).toEqual([EMAIL.path])
    })
    expect(main.copied).toEqual([NOTES.path])
  })

  it('shows a missing file muted, as missing, and offers none of its actions', async () => {
    await renderTab({ fileInfo: { ...INFO, [GUIDE.path]: { kind: FileInfoKind.Missing } } })

    await waitFor(() => {
      expect(card('Upgrade guide')).toHaveTextContent('Markdown · missing')
    })
    expect(card('Upgrade guide').className).toMatch(/missing/)
    expect(card('Release notes 2.4').className).not.toMatch(/missing/)
    for (const name of ['Open', 'Copy', 'Reveal in folder']) expect(button('Upgrade guide', name)).toBeDisabled()
  })

  it('offers no Copy for a file that isn’t text, and shows only its type and age', async () => {
    const logo = artifact('assets/logo.png', 'Logo', 3)
    await renderTab({
      artifacts: [logo],
      fileInfo: { [logo.path]: { kind: FileInfoKind.Other, modifiedAt: NOW - 3 * MINUTE } },
    })

    await waitFor(() => {
      expect(card('Logo')).toHaveTextContent('PNG · 3m ago')
    })
    expect(button('Logo', 'Copy')).toBeDisabled()
    expect(button('Logo', 'Open')).toBeEnabled()
    expect(button('Logo', 'Reveal in folder')).toBeEnabled()
  })

  it('shows a file it can’t look at as missing', async () => {
    await renderTab({
      overrides: { [CommandName.FilesInfo]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'EACCES')) },
    })

    await waitFor(() => {
      expect(card('Release notes 2.4')).toHaveTextContent('Markdown · missing')
    })
  })

  it('looks at a file again when an action on it fails, finding it gone', async () => {
    const info = { ...INFO }
    const { invoke } = await renderTab({
      fileInfo: info,
      overrides: {
        [CommandName.FilesCopy]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
        [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
        [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task')),
      },
    })
    await waitFor(() => {
      expect(button('Release notes 2.4', 'Copy')).toBeEnabled()
    })
    const looks = (): number =>
      invoke.mock.calls.filter(
        ([command, request]) => command === CommandName.FilesInfo && 'path' in request && request.path === NOTES.path,
      ).length

    info[NOTES.path] = { kind: FileInfoKind.Missing }
    fireEvent.click(button('Release notes 2.4', 'Copy'))
    await waitFor(() => {
      expect(card('Release notes 2.4')).toHaveTextContent('Markdown · missing')
    })
    expect(looks()).toBe(2)

    fireEvent.click(button('Upgrade guide', 'Reveal in folder'))
    fireEvent.click(button('Announcement email', 'Open'))
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === CommandName.FilesInfo)).toHaveLength(6)
    })
  })

  it('keeps up as the agent declares artifacts and works on their files', async () => {
    const info = { ...INFO }
    const { emit, invoke } = await renderTab({ artifacts: [NOTES], fileInfo: info })
    await waitFor(() => {
      expect(card('Release notes 2.4')).toHaveTextContent('128 lines')
    })

    act(() => {
      emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [NOTES, GUIDE] })
    })
    expect(card('Upgrade guide')).toBeInTheDocument()

    // A tool call finishing may have changed the file: the cards look again.
    info[NOTES.path] = { kind: FileInfoKind.Text, lines: 140, modifiedAt: NOW }
    const edit: ToolEvent = {
      id: 'n1',
      taskId: 't1',
      turn: 1,
      createdAt: NOW,
      kind: ToolEventKind.Narration,
      text: 'Adding the fixes.',
      parentToolUseId: null,
    }
    act(() => {
      emit({ type: EventType.ToolEventAppended, toolEvent: edit })
    })
    await waitFor(() => {
      expect(card('Release notes 2.4')).toHaveTextContent('Markdown · 140 lines · just now')
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesInfo, { taskId: 't1', path: NOTES.path })
  })
})

describe('an artifact’s context menu', () => {
  async function choose(title: string, label: string): Promise<void> {
    fireEvent.contextMenu(card(title))
    await act(() => Promise.resolve())
    // The label, then its shortcut if any: "Open" isn't "Open in editor".
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}(?![ a-z])`) }))
    await act(() => Promise.resolve())
  }

  it('has the reference’s items, and opens on ⇧F10 from the card’s buttons', async () => {
    await renderTab()

    fireEvent.keyDown(button('Upgrade guide', 'Open'), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open↵',
      'Open in editor⌘⇧E',
      'Copy contents',
      'Copy path',
      'Reveal in Finder',
      'Remove from artifacts',
    ])
  })

  it('opens the file in the Files tab or the editor, copies it or its path, and reveals it', async () => {
    const { store, invoke, main } = await renderTab()

    await choose('Upgrade guide', 'Open')
    await waitFor(() => {
      expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')
    })
    expect(store.getState().openFiles.t1?.activePath).toBe(GUIDE.path)

    await choose('Upgrade guide', 'Open in editor')
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpenInEditor, { taskId: 't1', path: GUIDE.path })

    await choose('Upgrade guide', 'Copy contents')
    await choose('Upgrade guide', 'Copy path')
    await choose('Upgrade guide', 'Reveal in Finder')
    expect(main.copied).toEqual([GUIDE.path, `${sampleWorkspace('w1').rootPath}/${GUIDE.path}`])
    expect(main.revealed).toEqual([GUIDE.path])
  })

  it('removes an artifact, leaving the others', async () => {
    await renderTab()

    await choose('Upgrade guide', 'Remove from artifacts')

    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'Upgrade guide' })).toBeNull()
    })
    expect(screen.getAllByRole('listitem').map((element) => element.getAttribute('aria-label'))).toEqual([
      'Release notes 2.4',
      'Announcement email',
    ])
  })

  it('shows a toast when an item fails', async () => {
    await renderTab({
      overrides: {
        [CommandName.ArtifactsRemove]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'Not an artifact')),
      },
    })

    await choose('Upgrade guide', 'Remove from artifacts')

    expect(await screen.findByText('Not an artifact')).toBeInTheDocument()
  })
})

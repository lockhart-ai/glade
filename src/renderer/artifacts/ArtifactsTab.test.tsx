import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  ArtifactDateGroup,
  FileThumbnailKind,
  UiStateKey,
  type Artifact,
  type ArtifactGroupFold,
  type EpochMs,
  type FileThumbnail,
  type OpenFiles,
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
import { STUB_ROW_HEIGHT, STUB_VIEWPORT_HEIGHT } from '../test-layout'
import { ArtifactsTab } from './ArtifactsTab'

/** A local time: `month` counts from 1. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): EpochMs {
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

// Saturday 26 September 2026, 14:20.
const NOW = local(2026, 9, 26, 14, 20)
const MINUTE = 60_000

function artifact(
  path: string,
  title: string,
  modifiedAt: EpochMs | null,
  declaredAt: EpochMs = NOW - MINUTE,
): Artifact {
  return { taskId: 't1', path, title, addedAt: declaredAt, updatedAt: declaredAt, modifiedAt, missing: false }
}

const LANDING = artifact('out/screens/landing-dark.png', 'Landing page, dark theme', NOW - 8 * MINUTE)
const CHANGELOG = artifact('docs/site/changelog.md', 'Changelog page draft', NOW - 14 * MINUTE)
const RATES = artifact('docs/site/rate-limits.md', 'Rate limits reference', local(2026, 9, 26, 12, 20))
const SEARCH = artifact('out/screens/search-mobile.png', 'Search results on mobile', local(2026, 9, 25, 16, 40))
const NAV = artifact('site/src/components/NavSidebar.tsx', 'Nav sidebar component', local(2026, 9, 25, 15, 2))
const IA = artifact('docs/site/ia.md', 'Information architecture', local(2026, 9, 22, 10, 0))
const OLD = artifact('docs/site/old-nav.md', 'Old navigation audit', local(2026, 8, 3, 9, 0))

/** Declared in this order: the tab lists them by when each file last changed, not this. */
const ARTIFACTS = [IA, NAV, LANDING, OLD, RATES, SEARCH, CHANGELOG]

const THUMBNAILS: Readonly<Record<string, FileThumbnail>> = {
  [LANDING.path]: { kind: FileThumbnailKind.Image, dataUrl: 'data:image/png;base64,bGFuZGluZw==' },
  [SEARCH.path]: { kind: FileThumbnailKind.Image, dataUrl: 'data:image/png;base64,c2VhcmNo' },
}

interface Setup {
  readonly artifacts?: readonly Artifact[]
  readonly thumbnails?: Readonly<Record<string, FileThumbnail>>
  readonly artifactGroups?: Record<string, ArtifactGroupFold[]>
  readonly openFiles?: OpenFiles[]
  readonly overrides?: Partial<FakeHandlers>
  /** The main side to render over, as a relaunch finds it. A new one when left out. */
  readonly main?: TabMain
}

type TabMain = FakeMain & {
  copied: string[]
  revealed: string[]
  artifactGroups: Record<string, ArtifactGroupFold[]>
  watchedArtifacts: string[]
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: TabMain
  readonly unmount: () => void
}

function tabMain({ artifacts = ARTIFACTS, thumbnails = THUMBNAILS, artifactGroups = {}, openFiles }: Setup): TabMain {
  return {
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
      { key: UiStateKey.RightPanelTab, value: 'artifacts' },
    ],
    artifacts,
    thumbnails,
    artifactGroups,
    ...(openFiles === undefined ? {} : { openFiles }),
    copied: [],
    revealed: [],
    watchedArtifacts: [],
  }
}

async function renderTab(setup: Setup = {}): Promise<Rendered> {
  const main = setup.main ?? tabMain(setup)
  const fake = fakeBridge(main, setup.overrides)
  const store = createGladeStore(fake.bridge)
  await act(async () => {
    await store.getState().hydrate()
    await store.getState().loadHistory('t1')
  })
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <ArtifactsTab taskId="t1" now={NOW} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, main, unmount }
}

/** The tab's date groups. */
function groups(): HTMLElement[] {
  const tab = screen.queryByRole('group', { name: 'Artifacts' })
  return tab === null ? [] : within(tab).queryAllByRole('region')
}

function group(name: string): HTMLElement {
  const found = groups().find((element) => element.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`No ${name} group`)
  return found
}

/** A group's header: its name, then its count. */
function header(name: string): HTMLElement {
  return within(group(name)).getByRole('button', { name: new RegExp(`^${name}\\s?\\d+$`) })
}

/** The titles of a group's rows, in order. */
function titles(name: string): (string | null)[] {
  return within(group(name))
    .queryAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label'))
}

function row(title: string): HTMLElement {
  return screen.getByRole('listitem', { name: title })
}

function button(title: string, name: string): HTMLElement {
  return within(row(title)).getByRole('button', { name })
}

/** How many times the tab asked main for a file's thumbnail. */
function looks(invoke: FakeBridge['invoke'], path?: string): number {
  return invoke.mock.calls.filter(
    ([command, request]) =>
      command === CommandName.FilesThumbnail && (path === undefined || ('path' in request && request.path === path)),
  ).length
}

describe('ArtifactsTab', () => {
  it('groups artifacts by date, newest file first, Today and Yesterday open and the older groups folded', async () => {
    await renderTab()

    expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'Older',
    ])
    expect(header('Today')).toHaveTextContent('Today3')
    expect(header('Today')).toHaveAttribute('aria-expanded', 'true')
    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Changelog page draft', 'Rate limits reference'])
    expect(titles('Yesterday')).toEqual(['Search results on mobile', 'Nav sidebar component'])
    expect(header('This week')).toHaveAttribute('aria-expanded', 'false')
    expect(header('This week')).toHaveTextContent('This week1')
    expect(titles('This week')).toEqual([])
    expect(header('Older')).toHaveAttribute('aria-expanded', 'false')
    expect(titles('Older')).toEqual([])
  })

  it('shows each row’s title, type and age: minutes or hours today, the time yesterday', async () => {
    await renderTab()

    expect(row('Landing page, dark theme')).toHaveTextContent(/^Landing page, dark themePNG8m/)
    expect(row('Rate limits reference')).toHaveTextContent(/^Rate limits referenceMarkdown2h/)
    expect(row('Nav sidebar component')).toHaveTextContent(/^Nav sidebar componentTypeScript15:02/)
    expect(within(row('Nav sidebar component')).getByText('15:02')).toHaveAttribute('title', 'Sep 25, 2026, 3:02 PM')
    expect(within(row('Landing page, dark theme')).getByRole('button', { name: /^Landing page/ })).toHaveAttribute(
      'title',
      LANDING.path,
    )
  })

  it('shows a thumbnail of an image once main has made it, and a type tile for anything else', async () => {
    await renderTab()

    await waitFor(() => {
      expect(row('Landing page, dark theme').querySelector('img')).toHaveAttribute(
        'src',
        'data:image/png;base64,bGFuZGluZw==',
      )
    })
    expect(row('Search results on mobile').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,c2VhcmNo',
    )
    expect(row('Changelog page draft').querySelector('img')).toBeNull()
    expect(row('Changelog page draft').querySelector('svg')).not.toBeNull()
  })

  it('shows the type tile until the thumbnail is ready, never holding the list back', async () => {
    let finish: (thumbnail: { thumbnail: FileThumbnail }) => void = () => undefined
    const made = new Promise<{ thumbnail: FileThumbnail }>((resolve) => {
      finish = resolve
    })
    await renderTab({ overrides: { [CommandName.FilesThumbnail]: () => made } })

    expect(titles('Today')).toHaveLength(3)
    expect(row('Landing page, dark theme').querySelector('img')).toBeNull()
    expect(row('Landing page, dark theme')).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      finish({ thumbnail: THUMBNAILS[LANDING.path] ?? { kind: FileThumbnailKind.None } })
      await made
    })
    await waitFor(() => {
      expect(row('Landing page, dark theme').querySelector('img')).not.toBeNull()
    })
    // Still busy until the image has loaded.
    expect(row('Landing page, dark theme')).toHaveAttribute('aria-busy', 'true')
    fireEvent.load(row('Landing page, dark theme').querySelector('img') ?? document.body)
    expect(row('Landing page, dark theme')).toHaveAttribute('aria-busy', 'false')
  })

  it('shows the type tile for a thumbnail the window can’t draw', async () => {
    await renderTab()
    await waitFor(() => {
      expect(row('Landing page, dark theme').querySelector('img')).not.toBeNull()
    })

    fireEvent.error(row('Landing page, dark theme').querySelector('img') ?? document.body)

    expect(row('Landing page, dark theme').querySelector('img')).toBeNull()
    expect(row('Landing page, dark theme')).toHaveAttribute('aria-busy', 'false')
  })

  it('shows the type tile for an image main can’t make a thumbnail of, or can’t be asked about', async () => {
    await renderTab({
      thumbnails: { [LANDING.path]: { kind: FileThumbnailKind.None } },
      overrides: {
        [CommandName.FilesThumbnail]: ({ path }) =>
          path === SEARCH.path
            ? refuse(bridgeError(BridgeErrorCode.Internal, 'Quick Look failed'))
            : { thumbnail: { kind: FileThumbnailKind.None } },
      },
    })

    await waitFor(() => {
      expect(button('Search results on mobile', 'Open')).toBeEnabled()
    })
    expect(row('Landing page, dark theme').querySelector('img')).toBeNull()
    expect(row('Search results on mobile').querySelector('img')).toBeNull()
    expect(row('Search results on mobile').className).not.toMatch(/missing/)
  })

  it('shows a file that’s gone muted, at its last known time, as missing, with no Open or Reveal', async () => {
    await renderTab({
      artifacts: [{ ...LANDING, missing: true }, CHANGELOG],
      thumbnails: { [CHANGELOG.path]: { kind: FileThumbnailKind.Missing } },
    })

    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Changelog page draft'])
    expect(row('Landing page, dark theme')).toHaveTextContent(/PNG · missing8m/)
    expect(row('Landing page, dark theme').className).toMatch(/missing/)
    // One main finds gone when it looks for its thumbnail is missing too.
    await waitFor(() => {
      expect(row('Changelog page draft')).toHaveTextContent('Markdown · missing')
    })
    for (const title of ['Landing page, dark theme', 'Changelog page draft']) {
      expect(button(title, 'Open')).toBeDisabled()
      expect(button(title, 'Reveal in folder')).toBeDisabled()
      expect(button(title, 'More')).toBeEnabled()
    }
  })

  it('says so when the agent has declared none', async () => {
    await renderTab({ artifacts: [] })

    expect(screen.getByText('No artifacts yet.')).toBeInTheDocument()
    expect(groups()).toEqual([])
    expect(screen.queryByRole('group', { name: 'Artifacts' })).toBeNull()
  })

  it('makes a single group of artifacts all from one day', async () => {
    await renderTab({ artifacts: [IA, artifact('docs/site/search.md', 'Search plan', local(2026, 9, 22, 9, 0))] })

    expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual(['This week'])
    fireEvent.click(header('This week'))
    await waitFor(() => {
      expect(titles('This week')).toEqual(['Information architecture', 'Search plan'])
    })
    expect(row('Search plan')).toHaveTextContent('Sep 22')
  })
})

describe('folding a date group', () => {
  it('folds and opens a group from its header, and has main remember it for the task', async () => {
    const { invoke, main } = await renderTab()

    fireEvent.click(header('Today'))
    await waitFor(() => {
      expect(titles('Today')).toEqual([])
    })
    expect(header('Today')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header('Older'))
    await waitFor(() => {
      expect(titles('Older')).toEqual(['Old navigation audit'])
    })
    expect(row('Old navigation audit')).toHaveTextContent('Aug 3')

    expect(invoke).toHaveBeenCalledWith(CommandName.ArtifactsSetGroupOpen, {
      taskId: 't1',
      group: ArtifactDateGroup.Today,
      open: false,
    })
    expect(main.artifactGroups.t1).toEqual([
      { group: ArtifactDateGroup.Today, open: false },
      { group: ArtifactDateGroup.Older, open: true },
    ])
  })

  it('shows the groups as they were left after a relaunch', async () => {
    const first = await renderTab()
    fireEvent.click(header('Yesterday'))
    fireEvent.click(header('This week'))
    await waitFor(() => {
      expect(titles('This week')).toEqual(['Information architecture'])
    })
    first.unmount()

    // A new window over the same main, as after a relaunch.
    await renderTab({ main: first.main })

    expect(header('Today')).toHaveAttribute('aria-expanded', 'true')
    expect(header('Yesterday')).toHaveAttribute('aria-expanded', 'false')
    expect(titles('Yesterday')).toEqual([])
    expect(titles('This week')).toEqual(['Information architecture'])
    expect(header('Older')).toHaveAttribute('aria-expanded', 'false')
  })

  it('still folds when main can’t remember it', async () => {
    await renderTab({
      overrides: { [CommandName.ArtifactsSetGroupOpen]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk')) },
    })

    fireEvent.click(header('Today'))

    await waitFor(() => {
      expect(titles('Today')).toEqual([])
    })
  })
})

describe('a row', () => {
  it('opens its file in the Files tab when clicked, or with Open', async () => {
    const { store, invoke } = await renderTab()

    fireEvent.click(within(row('Changelog page draft')).getByRole('button', { name: /^Changelog page draft/ }))
    await waitFor(() => {
      expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: CHANGELOG.path })
    expect(store.getState().openFiles.t1?.activePath).toBe(CHANGELOG.path)

    fireEvent.click(button('Nav sidebar component', 'Open'))
    await waitFor(() => {
      expect(store.getState().openFiles.t1?.activePath).toBe(NAV.path)
    })
  })

  it('offers Open, Reveal in folder and More, in that order', async () => {
    await renderTab()

    expect(
      within(row('Search results on mobile'))
        .getAllByRole('button')
        .slice(1)
        .map((element) => element.getAttribute('aria-label')),
    ).toEqual(['Open', 'Reveal in folder', 'More'])
  })

  it('reveals its file in its folder, through main', async () => {
    const { main } = await renderTab()

    fireEvent.click(button('Search results on mobile', 'Reveal in folder'))

    await waitFor(() => {
      expect(main.revealed).toEqual([SEARCH.path])
    })
  })

  it('opens its context menu from More, below the button', async () => {
    await renderTab()

    fireEvent.click(button('Rate limits reference', 'More'))
    await act(() => Promise.resolve())

    expect(screen.getByRole('menu', { name: 'Artifact actions' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toContain('Remove from artifacts')
  })

  it('is outlined while its file is the one the Files tab shows', async () => {
    await renderTab({ openFiles: [{ taskId: 't1', paths: [RATES.path, NAV.path], activePath: RATES.path }] })

    expect(row('Rate limits reference')).toHaveAttribute('aria-current', 'true')
    expect(row('Rate limits reference').className).toMatch(/selected/)
    expect(row('Nav sidebar component')).not.toHaveAttribute('aria-current')
  })

  it('looks at its file again when an action on it fails', async () => {
    const { invoke } = await renderTab({
      overrides: {
        [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
        [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task')),
      },
    })
    await waitFor(() => {
      expect(looks(invoke, SEARCH.path)).toBe(1)
    })

    fireEvent.click(button('Search results on mobile', 'Reveal in folder'))
    await waitFor(() => {
      expect(looks(invoke, SEARCH.path)).toBe(2)
    })
    fireEvent.click(button('Search results on mobile', 'Open'))
    await waitFor(() => {
      expect(looks(invoke, SEARCH.path)).toBe(3)
    })
  })
})

describe('keeping up', () => {
  it('moves an artifact whose file changed to the top, into Today, and looks at its thumbnail again', async () => {
    const { emit, invoke } = await renderTab()
    await waitFor(() => {
      expect(looks(invoke, NAV.path)).toBe(1)
    })

    act(() => {
      emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: ARTIFACTS.map((each) => (each === NAV ? { ...NAV, modifiedAt: NOW - 30_000 } : each)),
      })
    })

    expect(titles('Today')).toEqual([
      'Nav sidebar component',
      'Landing page, dark theme',
      'Changelog page draft',
      'Rate limits reference',
    ])
    expect(row('Nav sidebar component')).toHaveTextContent('TypeScriptnow')
    expect(titles('Yesterday')).toEqual(['Search results on mobile'])
    await waitFor(() => {
      expect(looks(invoke, NAV.path)).toBe(2)
    })
  })

  it('shows a file that goes missing where it was, and takes a new title in place', async () => {
    const { emit } = await renderTab()

    act(() => {
      emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: ARTIFACTS.map((each) =>
          each === CHANGELOG
            ? { ...CHANGELOG, missing: true }
            : each === RATES
              ? { ...RATES, title: 'Rate limits, final', updatedAt: NOW }
              : each,
        ),
      })
    })

    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Changelog page draft', 'Rate limits, final'])
    expect(row('Changelog page draft')).toHaveTextContent('Markdown · missing')
  })

  it('adds a new artifact in its place, and drops a removed one', async () => {
    const { emit } = await renderTab()
    const brief = artifact('docs/site/brief.md', 'Design brief', NOW - 3 * MINUTE)

    act(() => {
      emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: [...ARTIFACTS.filter((each) => each !== LANDING), brief],
      })
    })

    expect(titles('Today')).toEqual(['Design brief', 'Changelog page draft', 'Rate limits reference'])
    expect(screen.queryByRole('listitem', { name: 'Landing page, dark theme' })).toBeNull()
  })

  it('has main watch the task’s files while the tab shows it, and stop once it doesn’t', async () => {
    const { main, unmount } = await renderTab()
    await waitFor(() => {
      expect(main.watchedArtifacts).toEqual(['watch t1'])
    })

    unmount()

    await waitFor(() => {
      expect(main.watchedArtifacts).toEqual(['watch t1', 'unwatch t1'])
    })
  })

  it('shows its artifacts though main can’t watch them', async () => {
    await renderTab({
      overrides: {
        [CommandName.ArtifactsWatch]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'EMFILE')),
        [CommandName.ArtifactsUnwatch]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'EMFILE')),
      },
    })

    expect(titles('Today')).toHaveLength(3)
  })
})

describe('hundreds of artifacts', () => {
  const MANY = Array.from({ length: 250 }, (_, index) =>
    artifact(
      `out/screens/shot-${String(index).padStart(3, '0')}.png`,
      `Screenshot ${String(index)}`,
      NOW - index * 1000,
    ),
  )

  it('renders only the rows in view, and asks for only their thumbnails', async () => {
    const { invoke } = await renderTab({ artifacts: MANY, thumbnails: {} })

    expect(header('Today')).toHaveTextContent('Today250')
    const shown = titles('Today')
    // A screenful, and a few past it: nowhere near all of them.
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThanOrEqual(Math.ceil(STUB_VIEWPORT_HEIGHT / STUB_ROW_HEIGHT) + 20)
    expect(shown[0]).toBe('Screenshot 0')
    await waitFor(() => {
      expect(looks(invoke)).toBe(shown.length)
    })
  })

  it('keeps the list as tall as all of them, so it scrolls as if they were all there', async () => {
    await renderTab({ artifacts: MANY, thumbnails: {} })

    const list = within(group('Today')).getByRole('list')
    expect(Number.parseFloat(list.style.height)).toBeGreaterThan(200 * 40)
  })
})

describe('an artifact’s context menu', () => {
  async function choose(title: string, label: string): Promise<void> {
    fireEvent.contextMenu(row(title))
    await act(() => Promise.resolve())
    // The label, then its shortcut if any: "Open" isn't "Open in editor".
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}(?![ a-z])`) }))
    await act(() => Promise.resolve())
  }

  it('has the reference’s items, and opens on ⇧F10 from the row’s buttons', async () => {
    await renderTab()

    fireEvent.keyDown(button('Changelog page draft', 'Open'), { key: 'F10', shiftKey: true })
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

    await choose('Changelog page draft', 'Open')
    await waitFor(() => {
      expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')
    })
    expect(store.getState().openFiles.t1?.activePath).toBe(CHANGELOG.path)

    await choose('Changelog page draft', 'Open in editor')
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpenInEditor, { taskId: 't1', path: CHANGELOG.path })

    await choose('Changelog page draft', 'Copy contents')
    await choose('Changelog page draft', 'Copy path')
    await choose('Changelog page draft', 'Reveal in Finder')
    expect(main.copied).toEqual([CHANGELOG.path, `${sampleWorkspace('w1').rootPath}/${CHANGELOG.path}`])
    expect(main.revealed).toEqual([CHANGELOG.path])
  })

  it('removes an artifact, leaving the others, and the group’s count follows', async () => {
    await renderTab()

    await choose('Changelog page draft', 'Remove from artifacts')

    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'Changelog page draft' })).toBeNull()
    })
    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Rate limits reference'])
    expect(header('Today')).toHaveTextContent('Today2')
  })

  it('drops a group once its last artifact is removed', async () => {
    await renderTab({ artifacts: [LANDING, OLD] })
    fireEvent.click(header('Older'))
    await waitFor(() => {
      expect(titles('Older')).toEqual(['Old navigation audit'])
    })

    await choose('Old navigation audit', 'Remove from artifacts')

    await waitFor(() => {
      expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual(['Today'])
    })
  })

  it('shows a toast when an item fails', async () => {
    await renderTab({
      overrides: {
        [CommandName.ArtifactsRemove]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'Not an artifact')),
      },
    })

    await choose('Changelog page draft', 'Remove from artifacts')

    expect(await screen.findByText('Not an artifact')).toBeInTheDocument()
  })
})

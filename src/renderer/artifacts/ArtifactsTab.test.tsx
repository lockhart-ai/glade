import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  ArtifactDateGroup,
  ArtifactFilter,
  ArtifactKind,
  FileContentKind,
  FileThumbnailKind,
  UiStateKey,
  WorkspaceImageMediaType,
  type Artifact,
  type ArtifactGroupFold,
  type EpochMs,
  type FileArtifact,
  type FileContent,
  type FileThumbnail,
  type LinkArtifact,
  type OpenFiles,
} from '../../shared/domain'
import { settleFloating } from '../components/settleFloating'
import { ToastProvider } from '../components'
import { VIEWER_LABEL } from '../images/ImageViewer'
import { activePanelTab, PanelTab } from '../right-panel/panelModel'
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
): FileArtifact {
  return {
    kind: ArtifactKind.File,
    taskId: 't1',
    path,
    title,
    addedAt: declaredAt,
    updatedAt: declaredAt,
    modifiedAt,
    missing: false,
  }
}

const LANDING = artifact('out/screens/landing-dark.png', 'Landing page, dark theme', NOW - 8 * MINUTE)
const CHANGELOG = artifact('docs/site/changelog.md', 'Changelog page draft', NOW - 14 * MINUTE)
const RATES = artifact('docs/site/rate-limits.md', 'Rate limits reference', local(2026, 9, 26, 12, 20))
const SEARCH = artifact('out/screens/search-mobile.png', 'Search results on mobile', local(2026, 9, 25, 16, 40))
const NAV = artifact('site/src/components/NavSidebar.tsx', 'Nav sidebar component', local(2026, 9, 25, 15, 2))
const IA = artifact('docs/site/ia.md', 'Information architecture', local(2026, 9, 22, 10, 0))
const OLD = artifact('docs/site/old-nav.md', 'Old navigation audit', local(2026, 8, 3, 9, 0))

/** A link artifact (#407), declared at `declaredAt`, which dates it. */
function link(url: string, title: string, declaredAt: EpochMs): LinkArtifact {
  return { kind: ArtifactKind.Link, taskId: 't1', url, title, addedAt: declaredAt, updatedAt: declaredAt }
}

const PR = link('https://github.com/acme/api/pull/412', 'Docs site navigation refresh', NOW - 6 * MINUTE)
const ISSUE = link('https://github.com/acme/api/issues/398', 'Search misses hyphenated terms', NOW - 60 * MINUTE)
const TICKET = link('https://acme.atlassian.net/browse/API-123', 'Developer docs refresh', NOW - 110 * MINUTE)
const STYLE = link('https://example.com/style/code-samples', 'Code sample style guide', local(2026, 9, 25, 17, 5))
const LINKS = [PR, ISSUE, TICKET, STYLE]

/** Declared in this order: the tab lists them by when each file last changed, not this. */
const ARTIFACTS = [IA, NAV, LANDING, OLD, RATES, SEARCH, CHANGELOG]

const THUMBNAILS: Readonly<Record<string, FileThumbnail>> = {
  [LANDING.path]: { kind: FileThumbnailKind.Image, dataUrl: 'data:image/png;base64,bGFuZGluZw==' },
  [SEARCH.path]: { kind: FileThumbnailKind.Image, dataUrl: 'data:image/png;base64,c2VhcmNo' },
}

/** The two image artifacts' full-size reads (`files.read`), for the image viewer. */
const IMAGE_FILES: Readonly<Record<string, FileContent>> = {
  [LANDING.path]: {
    kind: FileContentKind.Image,
    mediaType: WorkspaceImageMediaType.Png,
    dataUrl: 'data:image/png;base64,bGFuZGluZyBmdWxs',
    size: 11,
  },
  [SEARCH.path]: {
    kind: FileContentKind.Image,
    mediaType: WorkspaceImageMediaType.Png,
    dataUrl: 'data:image/png;base64,c2VhcmNoIGZ1bGw=',
    size: 10,
  },
}

interface Setup {
  readonly artifacts?: readonly Artifact[]
  readonly thumbnails?: Readonly<Record<string, FileThumbnail>>
  readonly files?: Readonly<Record<string, FileContent>>
  readonly artifactGroups?: Record<string, ArtifactGroupFold[]>
  /** Each task's filter (#407), as main remembers it. */
  readonly artifactFilters?: Record<string, ArtifactFilter>
  readonly openFiles?: OpenFiles[]
  readonly overrides?: Partial<FakeHandlers>
  /** The main side to render over, as a relaunch finds it. A new one when left out. */
  readonly main?: TabMain
}

type TabMain = FakeMain & {
  copied: string[]
  revealed: string[]
  artifactGroups: Record<string, ArtifactGroupFold[]>
  artifactFilters: Record<string, ArtifactFilter>
  watchedArtifacts: string[]
  opened: string[]
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: TabMain
  readonly unmount: () => void
}

function tabMain({
  artifacts = ARTIFACTS,
  thumbnails = THUMBNAILS,
  files,
  artifactGroups = {},
  artifactFilters = {},
  openFiles,
}: Setup): TabMain {
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
    ...(files === undefined ? {} : { files }),
    artifactGroups,
    artifactFilters,
    ...(openFiles === undefined ? {} : { openFiles }),
    copied: [],
    revealed: [],
    watchedArtifacts: [],
    opened: [],
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

  it('makes a single group of artifacts all from one day, open as the only (so topmost) group showing', async () => {
    await renderTab({ artifacts: [IA, artifact('docs/site/search.md', 'Search plan', local(2026, 9, 22, 9, 0))] })

    expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual(['This week'])
    expect(header('This week')).toHaveAttribute('aria-expanded', 'true')
    expect(titles('This week')).toEqual(['Information architecture', 'Search plan'])
    expect(row('Search plan')).toHaveTextContent('Sep 22')
  })

  it('opens the topmost group showing to begin with, whatever it is, when the newest artifacts are from last week (#399)', async () => {
    const lastWeek = artifact('docs/site/pricing.md', 'Pricing page draft', local(2026, 9, 18, 11, 0))
    const older = artifact('docs/site/old-nav.md', 'Old navigation audit', local(2026, 8, 3, 9, 0))
    await renderTab({ artifacts: [lastWeek, older] })

    expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual(['Last week', 'Older'])
    // Last week is topmost, so it opens though it normally wouldn't; Older keeps its usual closed default.
    expect(header('Last week')).toHaveAttribute('aria-expanded', 'true')
    expect(titles('Last week')).toEqual(['Pricing page draft'])
    expect(header('Older')).toHaveAttribute('aria-expanded', 'false')
    expect(titles('Older')).toEqual([])
  })

  it('moves which group opens by default as the topmost one changes, but leaves your own choices alone (#399)', async () => {
    const lastWeek = artifact('docs/site/pricing.md', 'Pricing page draft', local(2026, 9, 18, 11, 0))
    const older = artifact('docs/site/old-nav.md', 'Old navigation audit', local(2026, 8, 3, 9, 0))
    const { emit } = await renderTab({ artifacts: [lastWeek, older] })
    expect(header('Last week')).toHaveAttribute('aria-expanded', 'true')

    // You close the topmost group yourself.
    fireEvent.click(header('Last week'))
    await waitFor(() => {
      expect(header('Last week')).toHaveAttribute('aria-expanded', 'false')
    })

    // A new artifact today makes Today the topmost group; Today opens on its own anyway, and your closed choice
    // for Last week, no longer topmost, is kept rather than reopened.
    act(() => {
      emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: [lastWeek, older, artifact('docs/site/today.md', 'Today’s notes', NOW - MINUTE)],
      })
    })

    expect(header('Today')).toHaveAttribute('aria-expanded', 'true')
    expect(header('Last week')).toHaveAttribute('aria-expanded', 'false')
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
      expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)
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
    // A non-image artifact: Open opens it in Files, as it does for any artifact that isn't an image.
    const { invoke } = await renderTab({
      overrides: {
        [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
        [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task')),
      },
    })
    await waitFor(() => {
      expect(looks(invoke, NAV.path)).toBe(1)
    })

    fireEvent.click(button('Nav sidebar component', 'Reveal in folder'))
    await waitFor(() => {
      expect(looks(invoke, NAV.path)).toBe(2)
    })
    fireEvent.click(button('Nav sidebar component', 'Open'))
    await waitFor(() => {
      expect(looks(invoke, NAV.path)).toBe(3)
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
      expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)
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

describe('the image viewer', () => {
  /** Clicks an artifact's row and waits for the viewer to open. */
  async function openViewer(title: string): Promise<HTMLElement> {
    fireEvent.click(within(row(title)).getByRole('button', { name: new RegExp(`^${title}`) }))
    await settleFloating()
    return screen.getByRole('dialog', { name: VIEWER_LABEL })
  }

  const viewerTitle = (viewer: HTMLElement): string | null =>
    within(viewer).getByTestId('image-viewer-title').textContent

  it('opens an image artifact’s row, steps through the task’s images (in date order, not the group’s), and returns the focus on close', async () => {
    await renderTab({ files: IMAGE_FILES })
    const trigger = within(row('Landing page, dark theme')).getByRole('button', {
      name: /^Landing page, dark theme/,
    })

    fireEvent.click(trigger)
    await settleFloating()
    const viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(viewerTitle(viewer)).toBe('Landing page, dark theme')
    const landingImage = IMAGE_FILES[LANDING.path]
    if (landingImage?.kind !== FileContentKind.Image) throw new Error('Not an image')
    expect(within(viewer).getByRole('img', { name: 'Landing page, dark theme' })).toHaveAttribute(
      'src',
      landingImage.dataUrl,
    )
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('1 of 2')

    // → steps to the task's other image artifact (Yesterday's Search results), skipping every non-image one between.
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe('Search results on mobile')
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('2 of 2')

    // Round from the last back to the first.
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe('Landing page, dark theme')

    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('takes the focus synchronously, so a ← pressed the instant it opens still steps it (#393)', async () => {
    await renderTab({ files: IMAGE_FILES })
    const trigger = within(row('Landing page, dark theme')).getByRole('button', {
      name: /^Landing page, dark theme/,
    })

    // No `settleFloating`: the viewer's own focus must already be there, not a frame later.
    fireEvent.click(trigger)
    const viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Close image' }))

    fireEvent.keyDown(document.activeElement ?? viewer, { key: 'ArrowLeft' })

    // Round from the first back to the last: Yesterday's Search results.
    expect(viewerTitle(viewer)).toBe('Search results on mobile')
  })

  it('steps only through the image artifacts the list shows, not those in a folded date group (#378)', async () => {
    // An older screenshot, declared too: its file last changed in August, so it sits under Older, folded as it starts.
    const august = artifact('out/screens/landing-light.png', 'Landing page, light theme', local(2026, 8, 3, 9, 0))
    const { store } = await renderTab({ artifacts: [...ARTIFACTS, august], files: IMAGE_FILES })
    expect(screen.getByRole('button', { name: /^Older/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem', { name: 'Landing page, light theme' })).not.toBeInTheDocument()

    let viewer = await openViewer('Landing page, dark theme')
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('1 of 2')
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe('Search results on mobile')
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('2 of 2')
    // Round to the first, never to the folded one.
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe('Landing page, dark theme')
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()

    // Opened, Older lists it, and the viewer steps to it as well, last, in the list's order.
    await act(async () => {
      await store.getState().setArtifactGroupOpen('t1', ArtifactDateGroup.Older, true)
    })
    viewer = await openViewer('Landing page, dark theme')
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('1 of 3')
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(viewerTitle(viewer)).toBe('Landing page, light theme')
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('3 of 3')
  })

  it('opens on a focused row’s ↵ (as a click on a button does) and with the Open action', async () => {
    await renderTab({ files: IMAGE_FILES })

    const trigger = within(row('Search results on mobile')).getByRole('button', { name: /^Search results/ })
    trigger.focus()
    fireEvent.click(trigger)
    await settleFloating()
    expect(screen.getByRole('dialog', { name: VIEWER_LABEL })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await settleFloating()

    fireEvent.click(button('Search results on mobile', 'Open'))
    await settleFloating()
    expect(screen.getByRole('dialog', { name: VIEWER_LABEL })).toBeInTheDocument()
  })

  it('a non-image artifact still opens in the Files tab, not the viewer', async () => {
    const { store } = await renderTab({ files: IMAGE_FILES })

    fireEvent.click(within(row('Changelog page draft')).getByRole('button', { name: /^Changelog page draft/ }))
    await waitFor(() => {
      expect(store.getState().openFiles.t1?.activePath).toBe(CHANGELOG.path)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Open in Files closes the viewer and opens the file in the Files tab', async () => {
    const { store, invoke } = await renderTab({ files: IMAGE_FILES })
    const viewer = await openViewer('Landing page, dark theme')

    fireEvent.click(within(viewer).getByRole('button', { name: 'Open in Files' }))

    await waitFor(() => {
      expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)
    })
    expect(store.getState().openFiles.t1?.activePath).toBe(LANDING.path)
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: LANDING.path })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Reveal in Finder reveals the file without closing the viewer', async () => {
    const { main } = await renderTab({ files: IMAGE_FILES })
    const viewer = await openViewer('Landing page, dark theme')

    fireEvent.click(within(viewer).getByRole('button', { name: 'Reveal in Finder' }))

    await waitFor(() => {
      expect(main.revealed).toEqual([LANDING.path])
    })
    expect(screen.getByRole('dialog', { name: VIEWER_LABEL })).toBeInTheDocument()
  })

  it('closes if the image it shows is no longer one of the task’s (removed, or no longer an image)', async () => {
    const { emit } = await renderTab({ files: IMAGE_FILES })
    await openViewer('Landing page, dark theme')

    act(() => {
      emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: ARTIFACTS.filter((each) => each !== LANDING),
      })
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the missing card for an image artifact main can’t read', async () => {
    // No files.read answer for Landing: main has nothing to read, as for a file that's gone.
    await renderTab({ files: {} })
    const viewer = await openViewer('Landing page, dark theme')

    expect(within(viewer).getByRole('img', { name: 'Image not available' })).toBeInTheDocument()
    expect(within(viewer).queryByRole('img', { name: 'Landing page, dark theme' })).not.toBeInTheDocument()
  })

  it('shows the missing card when the read itself fails', async () => {
    await renderTab({
      overrides: { [CommandName.FilesRead]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk error')) },
    })
    const viewer = await openViewer('Landing page, dark theme')

    expect(within(viewer).getByRole('img', { name: 'Image not available' })).toBeInTheDocument()
  })
})

describe('link artifacts (#407)', () => {
  /** The filter's chips, as `name pressed`. */
  function chips(): string[] {
    const filter = screen.queryByRole('group', { name: 'Show' })
    return filter === null
      ? []
      : within(filter)
          .getAllByRole('button')
          .map((chip) => `${chip.textContent} ${chip.getAttribute('aria-pressed') ?? ''}`)
  }

  function chip(name: string): HTMLElement {
    return within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: new RegExp(`^${name}`) })
  }

  async function choose(title: string, label: string): Promise<void> {
    fireEvent.contextMenu(row(title))
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    await act(() => Promise.resolve())
  }

  it('lists links among the files by when each was declared, saying what each is, with its kind’s icon', async () => {
    const { invoke } = await renderTab({ artifacts: [...ARTIFACTS, ...LINKS] })

    expect(titles('Today')).toEqual([
      'Docs site navigation refresh',
      'Landing page, dark theme',
      'Changelog page draft',
      'Search misses hyphenated terms',
      'Developer docs refresh',
      'Rate limits reference',
    ])
    expect(titles('Yesterday')).toEqual([
      'Code sample style guide',
      'Search results on mobile',
      'Nav sidebar component',
    ])
    expect(row('Docs site navigation refresh')).toHaveTextContent(/^Docs site navigation refresh#412 · acme\/api6m/)
    expect(row('Search misses hyphenated terms')).toHaveTextContent(/#398 · acme\/api1h$/)
    expect(row('Developer docs refresh')).toHaveTextContent(/API-1231h$/)
    expect(row('Code sample style guide')).toHaveTextContent(/example\.com17:05$/)
    const icon = (title: string): string | null | undefined =>
      row(title).querySelector('svg')?.getAttribute('data-icon')
    expect(LINKS.map(({ title }) => icon(title))).toEqual(['code-pull-request', 'circle-dot', 'ticket', 'link'])
    expect(within(row('Docs site navigation refresh')).getByRole('button', { name: /^Docs site/ })).toHaveAttribute(
      'title',
      PR.url,
    )
    // A link has no file: main is never asked for a thumbnail of it.
    await waitFor(() => {
      expect(looks(invoke)).toBeGreaterThan(0)
    })
    for (const { url } of LINKS) expect(looks(invoke, url)).toBe(0)
  })

  it('opens a link in the browser through main, by a click or Open link, and copies it, never opening Files', async () => {
    const { store, main } = await renderTab({ artifacts: [...ARTIFACTS, ...LINKS] })

    expect(
      within(row(PR.title))
        .getAllByRole('button')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual([null, 'Open link', 'Copy link', 'More'])
    fireEvent.click(within(row(PR.title)).getByRole('button', { name: /^Docs site/ }))
    fireEvent.click(button(ISSUE.title, 'Open link'))
    fireEvent.click(button(TICKET.title, 'Copy link'))

    await waitFor(() => {
      expect(main.opened).toEqual([PR.url, ISSUE.url])
    })
    expect(main.copied).toEqual([TICKET.url])
    expect(store.getState().openFiles.t1?.paths ?? []).toEqual([])
  })

  it('has a link’s menu from a right-click or More: Open link, Copy link and Remove from artifacts', async () => {
    const { main } = await renderTab({ artifacts: [...ARTIFACTS, ...LINKS] })

    fireEvent.click(button(PR.title, 'More'))
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open link↵',
      'Copy link',
      'Remove from artifacts',
    ])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    await choose(STYLE.title, 'Open link')
    await choose(STYLE.title, 'Copy link')
    await choose(PR.title, 'Remove from artifacts')

    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: PR.title })).toBeNull()
    })
    expect(main.opened).toEqual([STYLE.url])
    expect(main.copied).toEqual([STYLE.url])
  })

  it('opens no menu for an artifact taken off while its menu was on its way', async () => {
    const { emit } = await renderTab({ artifacts: [...ARTIFACTS, PR] })

    fireEvent.contextMenu(row(PR.title))
    act(() => {
      emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: ARTIFACTS })
    })
    await act(() => Promise.resolve())

    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('shows the filter only while the task has both files and links', async () => {
    const { emit } = await renderTab({ artifacts: ARTIFACTS })
    expect(chips()).toEqual([])

    act(() => {
      emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [...ARTIFACTS, PR, ISSUE] })
    })
    expect(chips()).toEqual(['All true', 'Files7 false', 'Links2 false'])

    act(() => {
      emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [PR, ISSUE] })
    })
    expect(chips()).toEqual([])
    expect(titles('Today')).toEqual([PR.title, ISSUE.title])
  })

  it('shows only the files or the links, recounting the groups, and has main remember the choice', async () => {
    const { main, invoke } = await renderTab({ artifacts: [...ARTIFACTS, ...LINKS] })

    fireEvent.click(chip('Links'))

    expect(chips()).toEqual(['All false', 'Files7 false', 'Links4 true'])
    expect(groups().map((element) => element.getAttribute('aria-label'))).toEqual(['Today', 'Yesterday'])
    expect(titles('Today')).toEqual([PR.title, ISSUE.title, TICKET.title])
    expect(header('Today')).toHaveTextContent('Today3')
    expect(titles('Yesterday')).toEqual([STYLE.title])
    await waitFor(() => {
      expect(main.artifactFilters).toEqual({ t1: ArtifactFilter.Links })
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.ArtifactsSetFilter, { taskId: 't1', filter: ArtifactFilter.Links })

    fireEvent.click(chip('Files'))
    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Changelog page draft', 'Rate limits reference'])
    expect(header('Today')).toHaveTextContent('Today3')

    fireEvent.click(chip('All'))
    expect(header('Today')).toHaveTextContent('Today6')
    await waitFor(() => {
      expect(main.artifactFilters).toEqual({ t1: ArtifactFilter.All })
    })
  })

  it('shows the filter as it was left after a relaunch, and all of them again once the task has one kind', async () => {
    const first = await renderTab({
      artifacts: [...ARTIFACTS, ...LINKS],
      artifactFilters: { t1: ArtifactFilter.Links },
    })
    expect(chips()).toEqual(['All false', 'Files7 false', 'Links4 true'])
    expect(titles('Today')).toEqual([PR.title, ISSUE.title, TICKET.title])

    // Its links taken off: the files all show, whatever was chosen.
    act(() => {
      first.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: ARTIFACTS })
    })
    expect(chips()).toEqual([])
    expect(titles('Today')).toEqual(['Landing page, dark theme', 'Changelog page draft', 'Rate limits reference'])
    // A link back, and the choice is too.
    act(() => {
      first.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [...ARTIFACTS, PR] })
    })
    expect(titles('Today')).toEqual([PR.title])
  })

  it('still filters when main can’t remember the choice', async () => {
    await renderTab({
      artifacts: [...ARTIFACTS, ...LINKS],
      overrides: {
        [CommandName.ArtifactsSetFilter]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'The database is locked')),
      },
    })

    fireEvent.click(chip('Links'))

    expect(titles('Today')).toEqual([PR.title, ISSUE.title, TICKET.title])
    await act(() => Promise.resolve())
  })

  it('never steps the image viewer onto a link, and shows no images under Links', async () => {
    await renderTab({ artifacts: [...ARTIFACTS, ...LINKS], files: IMAGE_FILES })

    fireEvent.click(within(row('Landing page, dark theme')).getByRole('button', { name: /^Landing page/ }))
    await settleFloating()
    const viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(within(viewer).getByRole('group', { name: 'Images' })).toHaveTextContent('1 of 2')
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(within(viewer).getByTestId('image-viewer-title')).toHaveTextContent('Search results on mobile')
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()

    fireEvent.click(chip('Links'))
    expect(screen.queryByRole('dialog', { name: VIEWER_LABEL })).toBeNull()
    for (const { title } of LINKS) expect(row(title)).toBeInTheDocument()
  })
})

// A file's and a link's tile in the todo hub (P16, #498): each does what its row in the Artifacts tab does, with the
// row's own pieces, and what their list keeps for them (`ArtifactTiles`): an artifact's context menu, and the image
// viewer over one todo's images. Rendered through the hub, as the Todos tab has them.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkKind, recogniseLink } from '../../../shared/artifactLinks'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../../shared/bridge'
import {
  FileContentKind,
  FileThumbnailKind,
  TodoState,
  WorkspaceImageMediaType,
  type FileArtifact,
  type FileContent,
  type FileThumbnail,
} from '../../../shared/domain'
import { ChildFilter, ChildKind, type TodoPanel } from '../../../shared/todoHub'
import thumbStyles from '../../artifacts/ArtifactThumb.module.css'
import { settleFloating } from '../../components/settleFloating'
import { VIEWER_LABEL } from '../../images/ImageViewer'
import { activePanelTab, PanelTab } from '../../right-panel/panelModel'
import { refuse, sampleWorkspace, type FakeBridge, type FakeHandlers, type FakeMain } from '../../store/test-bridge'
import { storeWrapper } from '../../store/test-wrapper'
import {
  HUB_NOW,
  HubForTask,
  hubFile,
  hubFiling,
  hubLink,
  hubMain,
  hubStore,
  hubTodo,
  minutesAgo,
  refOf,
  type HubStore,
  type HubTask,
} from '../test-hub'
import { ArtifactTiles } from './ArtifactTiles'
import { ChildTile } from './ChildTile'
import { FileTile } from './FileTile'
import { linkTagTitle, LinkTile } from './LinkTile'
import styles from './Tile.module.css'

const RATES = hubFile('docs/rate-limits.md', 'Rate limits reference', 6)
const HEADERS = hubFile('docs/img/rate-limit-headers.png', 'Rate limit headers, before and after', 9)
const BURST = hubFile('docs/img/burst.png', 'Requests in a burst', 12)
/** An image of the second todo: never one the first todo's viewer steps to. */
const SEARCH = hubFile('docs/img/search-limit.png', 'The /search limit, charted', 4)

const PR_509 = 'https://github.com/acme/api/pull/509'
const ISSUE_502 = 'https://github.com/acme/api/issues/502'
const TICKET = 'https://acme.atlassian.net/browse/API-123'
const PAGE = 'https://handbook.example.com/token-buckets'

const DOCS = '#503 Document the rate limits'
const LIMITS = '#502 Per-key limits for /search'

function open(todoId: string, filter = ChildFilter.All): TodoPanel {
  return { taskId: 't1', todoId, open: true, filter }
}

/**
 * Two todos, both open. Under the first, newest first: a Markdown file, a pull request, then two images. Under the
 * second: an image of its own, then an issue, a ticket and a plain page.
 */
const TASK: HubTask = {
  todos: [hubTodo('1', DOCS, TodoState.Done), hubTodo('2', LIMITS, TodoState.Doing)],
  artifacts: [
    BURST,
    hubLink(PR_509, 'Document the rate limits', 7),
    HEADERS,
    RATES,
    SEARCH,
    hubLink(ISSUE_502, '/search needs its own limit', 24),
    hubLink(TICKET, 'Limit /search per key', 30),
    hubLink(PAGE, 'Token buckets, explained', 19),
  ],
  filings: [
    hubFiling(refOf.file(RATES.path), '1'),
    hubFiling(refOf.file(HEADERS.path), '1'),
    hubFiling(refOf.file(BURST.path), '1'),
    hubFiling(refOf.link(PR_509), '1'),
    hubFiling(refOf.file(SEARCH.path), '2'),
    hubFiling(refOf.link(ISSUE_502), '2'),
    hubFiling(refOf.link(TICKET), '2'),
    hubFiling(refOf.link(PAGE), '2'),
  ],
  todoPanels: [open('1'), open('2')],
}

function thumbnailOf(name: string): FileThumbnail {
  return { kind: FileThumbnailKind.Image, dataUrl: `data:image/png;base64,${btoa(name)}` }
}

function imageOf(name: string): FileContent {
  return {
    kind: FileContentKind.Image,
    mediaType: WorkspaceImageMediaType.Png,
    dataUrl: `data:image/png;base64,${btoa(`${name} full`)}`,
    size: 12,
  }
}

const IMAGES = [HEADERS, BURST, SEARCH]
const THUMBNAILS = Object.fromEntries(IMAGES.map(({ path }) => [path, thumbnailOf(path)]))
const IMAGE_FILES = Object.fromEntries(IMAGES.map(({ path }) => [path, imageOf(path)]))

type TileMain = Partial<FakeMain> & {
  copied: string[]
  revealed: string[]
  opened: string[]
  openedInEditor: string[]
}

interface Rendered extends HubStore {
  readonly main: TileMain
}

async function renderHub(
  task: HubTask = TASK,
  extra: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<Rendered> {
  const main: TileMain = {
    ...hubMain(task),
    thumbnails: THUMBNAILS,
    files: IMAGE_FILES,
    copied: [],
    revealed: [],
    opened: [],
    openedInEditor: [],
    ...extra,
  }
  const wrapper = storeWrapper(main, overrides)
  await act(() => wrapper.store.getState().hydrate())
  render(<HubForTask />, { wrapper: wrapper.wrapper })
  await waitFor(() => {
    expect(wrapper.store.getState().filings.t1).toBeDefined()
  })
  // Every file's tile has been looked at.
  await waitFor(() => {
    expect(document.querySelector('[aria-busy="true"]:not(:has(img))')).toBeNull()
  })
  return { ...wrapper, main }
}

/** A tile, by its kind and title. */
function tile(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

function file(artifact: FileArtifact): HTMLElement {
  return tile(`File: ${artifact.title}`)
}

function button(of: HTMLElement, name: string): HTMLElement {
  return within(of).getByRole('button', { name })
}

/** The card whose head says `text`. */
function card(text: string): HTMLElement {
  const found = [...screen.getByRole('list', { name: 'Todos' }).querySelectorAll<HTMLElement>(':scope > li')].find(
    (each) => each.querySelector('[data-todo-head]')?.textContent.includes(text),
  )
  if (found === undefined) throw new Error(`No card says ${text}`)
  return found
}

/** The names of a card's tiles, in order. */
function tiles(text: string): (string | null)[] {
  return [...card(text).querySelectorAll('[role="group"][data-kind]')].map((each) => each.getAttribute('aria-label'))
}

/** A card's filter pills, as they're named, All first. */
function pills(text: string): (string | null)[] {
  return within(within(card(text)).getByRole('group', { name: 'Show' }))
    .getAllByRole('button')
    .map((each) => each.getAttribute('aria-label'))
}

/** How many times main was asked to look at a file. */
function looks(invoke: FakeBridge['invoke'], path: string): number {
  return invoke.mock.calls.filter(
    ([command, request]) => command === CommandName.FilesThumbnail && 'path' in request && request.path === path,
  ).length
}

/** The thumbnail a file's tile shows, if it has one. */
function thumbnail(artifact: FileArtifact): HTMLImageElement | null {
  return file(artifact).querySelector('img')
}

async function openMenu(of: HTMLElement): Promise<HTMLElement> {
  fireEvent.contextMenu(of)
  await act(() => Promise.resolve())
  return screen.getByRole('menu', { name: 'Artifact actions' })
}

/** Chooses an item of a tile's context menu: the label, then its shortcut if any (`Open` isn't `Open in editor`). */
async function choose(of: HTMLElement, label: string): Promise<void> {
  await openMenu(of)
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}(?![ a-z])`) }))
  await act(() => Promise.resolve())
}

function menuItems(): (string | null)[] {
  return screen.queryAllByRole('menuitem').map((item) => item.textContent)
}

/** Clicks an image's tile and waits for the viewer to open. */
async function openViewer(artifact: FileArtifact): Promise<HTMLElement> {
  fireEvent.click(file(artifact))
  await settleFloating()
  return screen.getByRole('dialog', { name: VIEWER_LABEL })
}

/** The title over the image showing, once each image the viewer holds has loaded, as the browser would load it. */
function viewerTitle(viewer: HTMLElement): string | null {
  for (const image of viewer.querySelectorAll('img')) fireEvent.load(image)
  return within(viewer).getByTestId('image-viewer-title').textContent
}

function position(viewer: HTMLElement): string | null {
  return within(viewer).queryByRole('group', { name: 'Images' })?.textContent ?? null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a file’s tile', () => {
  it('shows its type’s icon, its title, its type and how long ago the file last changed, with its path on its type', async () => {
    await renderHub()

    expect(file(RATES)).toHaveTextContent(/^Rate limits referenceMarkdown6m$/)
    expect(within(file(RATES)).getByText('Markdown')).toHaveAttribute('title', RATES.path)
    expect(file(RATES).querySelector('img')).toBeNull()
    expect(file(RATES)).not.toHaveClass(styles.muted ?? '', styles.selected ?? '')
    expect(file(RATES)).not.toHaveAttribute('aria-busy')
  })

  it('goes by when it was declared until Glade has looked at the file', async () => {
    const notes = { ...hubFile('notes', 'Notes', 6), modifiedAt: null, updatedAt: minutesAgo(40) }
    await renderHub({ artifacts: [notes] })
    expect(tile('File: Notes')).toHaveTextContent(/^NotesFile40m$/)
  })

  it('shows nothing for a file the task no longer has, or a link with a file’s key', async () => {
    const wrapper = await hubStore({ artifacts: [hubLink(PR_509, 'Document the rate limits')] })
    render(
      <ArtifactTiles taskId="t1" shown={[]}>
        <ChildTile taskId="t1" kind={ChildKind.File} childKey={PR_509} />
        <ChildTile taskId="t1" kind={ChildKind.File} childKey="docs/gone.md" />
      </ArtifactTiles>,
      { wrapper: wrapper.wrapper },
    )
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('opens its file in the Files tab on a click, on ↵ or Space with the focus, and with Open', async () => {
    const {
      store,
      fake: { invoke },
    } = await renderHub()

    fireEvent.click(within(file(RATES)).getByText('Rate limits reference'))
    await waitFor(() => {
      expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)
    })
    expect(store.getState().openFiles.t1?.activePath).toBe(RATES.path)
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpen, { taskId: 't1', path: RATES.path })

    invoke.mockClear()
    fireEvent.keyDown(file(RATES), { key: 'Enter' })
    fireEvent.keyDown(file(RATES), { key: ' ' })
    fireEvent.click(button(file(RATES), 'Open'))
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === CommandName.FilesOpen)).toHaveLength(3)
    })
    // Never the viewer: it isn't an image.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has Open, Reveal in folder and More, in that order, as real buttons the keyboard reaches', async () => {
    const { main } = await renderHub()

    const buttons = within(file(RATES)).getAllByRole('button')
    expect(buttons.map((each) => each.getAttribute('aria-label'))).toEqual(['Open', 'Reveal in folder', 'More'])
    expect(buttons.map((each) => each.getAttribute('title'))).toEqual(['Open', 'Reveal in folder', 'More'])
    // Icons, never text labels; each takes the focus in turn, after the tile itself.
    for (const each of buttons) {
      expect(each.tagName).toBe('BUTTON')
      expect(each).toHaveTextContent('')
      expect(each).toHaveClass(styles.action ?? '')
      expect(each).not.toHaveAttribute('tabindex')
    }
    expect(file(RATES)).toHaveClass(styles.acting ?? '')
    expect(button(file(RATES), 'More')).toHaveAttribute('aria-haspopup', 'menu')

    fireEvent.click(button(file(RATES), 'Reveal in folder'))
    await waitFor(() => {
      expect(main.revealed).toEqual([RATES.path])
    })
  })

  it('leaves a key pressed on one of its buttons to the button: ↵ on Reveal doesn’t open the file', async () => {
    const {
      fake: { invoke },
    } = await renderHub()
    invoke.mockClear()

    fireEvent.keyDown(button(file(RATES), 'Reveal in folder'), { key: 'Enter' })
    fireEvent.keyDown(button(file(RATES), 'More'), { key: ' ' })

    expect(invoke).not.toHaveBeenCalledWith(CommandName.FilesOpen, expect.anything())
  })

  it('is outlined while its file is the one the Files tab shows, and no other tile is', async () => {
    const { fake } = await renderHub(TASK, {
      openFiles: [{ taskId: 't1', paths: [RATES.path, HEADERS.path], activePath: RATES.path }],
    })

    expect(file(RATES)).toHaveClass(styles.selected ?? '')
    expect(file(RATES)).toHaveAttribute('aria-current', 'true')
    expect(file(HEADERS)).not.toHaveClass(styles.selected ?? '')
    expect(file(HEADERS)).not.toHaveAttribute('aria-current')

    // The Files tab shows another file, then Browse: the outline follows, then goes.
    act(() => {
      fake.emit({
        type: EventType.OpenFilesChanged,
        openFiles: { taskId: 't1', paths: [RATES.path, HEADERS.path], activePath: HEADERS.path },
      })
    })
    expect(file(RATES)).not.toHaveClass(styles.selected ?? '')
    expect(file(HEADERS)).toHaveClass(styles.selected ?? '')
    act(() => {
      fake.emit({
        type: EventType.OpenFilesChanged,
        openFiles: { taskId: 't1', paths: [RATES.path, HEADERS.path], activePath: null },
      })
    })
    expect(document.querySelector('[aria-current]')).toBeNull()
  })

  it('shows a title too long for it whole on hover, on one line', async () => {
    const long = 'A reference to every rate limit the public API has, per key, per route and per plan, with examples'
    await renderHub({
      ...TASK,
      artifacts: [hubFile(RATES.path, long, 6)],
      filings: [hubFiling(refOf.file(RATES.path), '1')],
    })

    const title = within(tile(`File: ${long}`)).getByTitle(long)
    expect(title).toHaveClass(styles.title ?? '')
    expect(title).toHaveTextContent(`${long}Markdown`)
    // Its buttons and its age are outside the title, which is what's cut short.
    expect(within(title).queryByRole('button')).toBeNull()
    expect(within(title).queryByText('6m')).toBeNull()
  })

  describe('a file that’s gone', () => {
    it('shows faded, as missing, and can’t be opened or revealed, as its row in the Artifacts tab', async () => {
      const gone = { ...RATES, missing: true }
      const {
        fake: { invoke },
      } = await renderHub({ ...TASK, artifacts: [gone, HEADERS] })

      expect(file(RATES)).toHaveTextContent(/^Rate limits referenceMarkdown · missing6m$/)
      expect(file(RATES)).toHaveClass(styles.muted ?? '')
      expect(file(RATES)).not.toHaveClass(styles.openable ?? '')
      expect(button(file(RATES), 'Open')).toBeDisabled()
      expect(button(file(RATES), 'Reveal in folder')).toBeDisabled()
      expect(button(file(RATES), 'More')).toBeEnabled()
      // Nothing about it is pink: it didn't fail, it's gone.
      expect(file(RATES).querySelector(`.${styles.failed ?? ''}`)).toBeNull()

      invoke.mockClear()
      fireEvent.click(file(RATES))
      fireEvent.keyDown(file(RATES), { key: 'Enter' })
      expect(invoke).not.toHaveBeenCalledWith(CommandName.FilesOpen, expect.anything())
    })

    it('is told by main’s look at it too, and can still be taken off the artifacts', async () => {
      await renderHub(TASK, { thumbnails: { ...THUMBNAILS, [RATES.path]: { kind: FileThumbnailKind.Missing } } })

      await waitFor(() => {
        expect(file(RATES)).toHaveTextContent('Markdown · missing')
      })
      expect(pills(DOCS)).toEqual(['All 4', '3 files', '1 link'])

      await choose(file(RATES), 'Remove from artifacts')
      await waitFor(() => {
        expect(screen.queryByRole('group', { name: 'File: Rate limits reference' })).toBeNull()
      })
      expect(pills(DOCS)).toEqual(['All 3', '2 files', '1 link'])
    })

    it('shows a missing image faded in its frame, with no thumbnail, and opens no viewer', async () => {
      await renderHub(TASK, { thumbnails: { ...THUMBNAILS, [HEADERS.path]: { kind: FileThumbnailKind.Missing } } })

      await waitFor(() => {
        expect(file(HEADERS)).toHaveTextContent('PNG · missing')
      })
      expect(thumbnail(HEADERS)).toBeNull()
      expect(file(HEADERS).querySelector(`.${thumbStyles.frame ?? ''}`)).not.toBeNull()
      fireEvent.click(file(HEADERS))
      await settleFloating()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('is looked at again when an action on it fails, and shows as missing once main finds it gone', async () => {
      const thumbnails: Record<string, FileThumbnail> = { ...THUMBNAILS }
      const {
        fake: { invoke },
      } = await renderHub(
        TASK,
        { thumbnails },
        {
          [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
          [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')),
        },
      )
      expect(looks(invoke, RATES.path)).toBe(1)

      fireEvent.click(button(file(RATES), 'Reveal in folder'))
      await waitFor(() => {
        expect(looks(invoke, RATES.path)).toBe(2)
      })
      expect(file(RATES)).toHaveTextContent(/Markdown6m$/)

      // By now it's gone.
      thumbnails[RATES.path] = { kind: FileThumbnailKind.Missing }
      fireEvent.click(file(RATES))
      await waitFor(() => {
        expect(looks(invoke, RATES.path)).toBe(3)
      })
      await waitFor(() => {
        expect(file(RATES)).toHaveTextContent('Markdown · missing')
      })
    })
  })

  describe('an image', () => {
    it('has its thumbnail where the icon goes, in the Artifacts tab’s 40×28 frame, once main has made it', async () => {
      await renderHub()

      const image = thumbnail(HEADERS)
      expect(image).toHaveAttribute('src', `data:image/png;base64,${btoa(HEADERS.path)}`)
      expect(image).toHaveAttribute('alt', '')
      expect(image?.parentElement).toHaveClass(thumbStyles.frame ?? '')
      expect(image?.parentElement?.parentElement).toHaveClass(styles.media ?? '')
      expect(file(HEADERS)).toHaveTextContent(/^Rate limit headers, before and afterPNG9m$/)
      // Busy until the thumbnail itself has loaded: a capture waits for it.
      expect(file(HEADERS)).toHaveAttribute('aria-busy', 'true')
      if (image !== null) fireEvent.load(image)
      expect(file(HEADERS)).not.toHaveAttribute('aria-busy')
    })

    it('keeps the thumbnail’s frame from the start, with its type’s icon, so it doesn’t grow as the thumbnail arrives', async () => {
      let answer: (thumbnail: FileThumbnail) => void = () => undefined
      const wrapper = storeWrapper(
        { ...hubMain(TASK) },
        {
          [CommandName.FilesThumbnail]: ({ path }) =>
            path === HEADERS.path
              ? new Promise((resolve) => {
                  answer = (made) => {
                    resolve({ thumbnail: made })
                  }
                })
              : { thumbnail: { kind: FileThumbnailKind.None } },
        },
      )
      await act(() => wrapper.store.getState().hydrate())
      render(<HubForTask />, { wrapper: wrapper.wrapper })
      await waitFor(() => {
        expect(screen.getByRole('group', { name: `File: ${HEADERS.title}` })).toBeInTheDocument()
      })

      const frame = (): Element | null => file(HEADERS).querySelector(`.${thumbStyles.frame ?? ''}`)
      expect(frame()?.parentElement).toHaveClass(styles.media ?? '')
      expect(frame()?.querySelector('svg')).not.toBeNull()
      expect(thumbnail(HEADERS)).toBeNull()
      expect(file(HEADERS)).toHaveAttribute('aria-busy', 'true')
      // A file that isn't an image has no frame: its icon alone.
      expect(file(RATES).querySelector(`.${thumbStyles.frame ?? ''}`)).toBeNull()

      await act(async () => {
        answer(thumbnailOf(HEADERS.path))
        await Promise.resolve()
      })
      expect(thumbnail(HEADERS)).not.toBeNull()
      expect(frame()?.parentElement).toHaveClass(styles.media ?? '')
    })

    it('shows its type’s icon in the frame for a thumbnail the window can’t draw', async () => {
      await renderHub()
      const image = thumbnail(HEADERS)
      if (image === null) throw new Error('No thumbnail')

      fireEvent.error(image)

      expect(thumbnail(HEADERS)).toBeNull()
      expect(file(HEADERS).querySelector(`.${thumbStyles.frame ?? ''} svg`)).not.toBeNull()
      expect(file(HEADERS)).not.toHaveAttribute('aria-busy')
      expect(file(HEADERS)).not.toHaveClass(styles.muted ?? '')
    })

    it('shows the icon for an image main can’t make a thumbnail of, or can’t be asked about', async () => {
      await renderHub(
        TASK,
        { thumbnails: {} },
        {
          [CommandName.FilesThumbnail]: ({ path }) =>
            path === BURST.path
              ? refuse(bridgeError(BridgeErrorCode.Internal, 'disk error'))
              : { thumbnail: { kind: FileThumbnailKind.None } },
        },
      )

      for (const image of [HEADERS, BURST]) {
        expect(thumbnail(image)).toBeNull()
        expect(file(image).querySelector(`.${thumbStyles.frame ?? ''} svg`)).not.toBeNull()
        expect(file(image)).not.toHaveAttribute('aria-busy')
        expect(file(image)).toHaveTextContent(/PNG\d+m$/)
      }
    })

    it('looks at its thumbnail again when its file changes', async () => {
      const { fake } = await renderHub()
      expect(looks(fake.invoke, HEADERS.path)).toBe(1)

      act(() => {
        fake.emit({
          type: EventType.ArtifactsChanged,
          taskId: 't1',
          artifacts: (TASK.artifacts ?? []).map((each) =>
            each === HEADERS ? { ...HEADERS, modifiedAt: HUB_NOW } : { ...each },
          ),
        })
      })

      await waitFor(() => {
        expect(looks(fake.invoke, HEADERS.path)).toBe(2)
      })
      // No other file was looked at again, and the changed one is now the todo's newest.
      expect(looks(fake.invoke, BURST.path)).toBe(1)
      expect(tiles(DOCS)[0]).toBe(`File: ${HEADERS.title}`)
    })
  })
})

describe('the image viewer, from an image’s tile', () => {
  it('opens on a click, steps through that todo’s images alone, in its order, and returns the focus to the tile', async () => {
    const {
      fake: { invoke },
    } = await renderHub()
    invoke.mockClear()

    const viewer = await openViewer(HEADERS)
    expect(viewerTitle(viewer)).toBe(HEADERS.title)
    expect(position(viewer)).toBe('1 of 2')
    expect(within(viewer).getByRole('button', { name: 'Previous image' })).toBeDisabled()
    // It didn't open in the Files tab.
    expect(invoke).not.toHaveBeenCalledWith(CommandName.FilesOpen, expect.anything())

    // → steps to the todo's other image, past the Markdown file and the link between them.
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe(BURST.title)
    expect(position(viewer)).toBe('2 of 2')
    expect(within(viewer).getByRole('button', { name: 'Next image' })).toBeDisabled()

    // → again goes nowhere: never on into the next todo's image.
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe(BURST.title)
    expect(within(viewer).queryByRole('img', { name: SEARCH.title })).toBeNull()
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(viewerTitle(viewer)).toBe(HEADERS.title)

    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(file(HEADERS)).toHaveFocus()
  })

  it('opens on ↵ with the focus and with Open, on the image it was opened from, and the tile takes the focus back', async () => {
    await renderHub()

    file(BURST).focus()
    fireEvent.keyDown(file(BURST), { key: 'Enter' })
    await settleFloating()
    let viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(viewerTitle(viewer)).toBe(BURST.title)
    expect(position(viewer)).toBe('2 of 2')
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close image' }))
    await settleFloating()
    expect(file(BURST)).toHaveFocus()

    fireEvent.click(button(file(HEADERS), 'Open'))
    await settleFloating()
    viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(viewerTitle(viewer)).toBe(HEADERS.title)
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()
    // The tile, not its Open button.
    expect(file(HEADERS)).toHaveFocus()
  })

  it('shows a todo’s one image alone, with nothing to step to', async () => {
    await renderHub()

    const viewer = await openViewer(SEARCH)

    expect(viewerTitle(viewer)).toBe(SEARCH.title)
    expect(position(viewer)).toBeNull()
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe(SEARCH.title)
  })

  it('steps through the same images under the Files filter as under All', async () => {
    await renderHub({ ...TASK, todoPanels: [open('1', ChildFilter.Files), open('2')] })
    expect(tiles(DOCS)).toEqual([`File: ${RATES.title}`, `File: ${HEADERS.title}`, `File: ${BURST.title}`])

    const viewer = await openViewer(BURST)

    expect(position(viewer)).toBe('2 of 2')
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(viewerTitle(viewer)).toBe(HEADERS.title)
  })

  it('steps through the images under no todo, in the placeholder group', async () => {
    await renderHub({ ...TASK, filings: [], todoPanels: [open('unfiled')] })

    const viewer = await openViewer(SEARCH)

    // Newest first: the /search chart, the headers, then the burst.
    expect(position(viewer)).toBe('1 of 3')
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe(HEADERS.title)
  })

  it('closes when the file it shows is removed, and the tile, its count and the viewer’s place go with it', async () => {
    const { fake } = await renderHub()
    const viewer = await openViewer(HEADERS)
    expect(position(viewer)).toBe('1 of 2')

    act(() => {
      fake.emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: (TASK.artifacts ?? []).filter((each) => each !== HEADERS),
      })
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('group', { name: `File: ${HEADERS.title}` })).toBeNull()
    expect(pills(DOCS)).toEqual(['All 3', '2 files', '1 link'])

    // The one image left opens alone.
    const again = await openViewer(BURST)
    expect(position(again)).toBeNull()
  })

  it('stays open, a step shorter, when another of the todo’s images is removed', async () => {
    const { fake } = await renderHub()
    const viewer = await openViewer(HEADERS)

    act(() => {
      fake.emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: (TASK.artifacts ?? []).filter((each) => each !== BURST),
      })
    })

    expect(screen.getByRole('dialog', { name: VIEWER_LABEL })).toBe(viewer)
    expect(viewerTitle(viewer)).toBe(HEADERS.title)
    expect(position(viewer)).toBeNull()
  })

  it('closes when the agent moves the image it shows to another todo', async () => {
    const { fake } = await renderHub()
    await openViewer(HEADERS)

    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.file(HEADERS.path), '2', HUB_NOW + 1)],
        removed: [],
      })
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tiles(LIMITS)).toContain(`File: ${HEADERS.title}`)
    // From its new todo, it steps through that todo's images.
    const viewer = await openViewer(HEADERS)
    expect(position(viewer)).toBe('2 of 2')
  })

  it('says so in place of an image that can’t be loaded, and still steps past it', async () => {
    await renderHub(TASK, { files: { [BURST.path]: imageOf(BURST.path) } })

    const viewer = await openViewer(HEADERS)

    expect(within(viewer).getByRole('img', { name: 'Image not available' })).toBeInTheDocument()
    expect(within(viewer).getByTestId('image-viewer-title')).toHaveTextContent(HEADERS.title)
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(viewerTitle(viewer)).toBe(BURST.title)
  })

  it('Open in Files closes it and opens the file in the Files tab; Reveal in Finder leaves it open', async () => {
    const { store, main } = await renderHub()
    const viewer = await openViewer(HEADERS)

    fireEvent.click(within(viewer).getByRole('button', { name: 'Reveal in Finder' }))
    await waitFor(() => {
      expect(main.revealed).toEqual([HEADERS.path])
    })
    expect(screen.getByRole('dialog', { name: VIEWER_LABEL })).toBeInTheDocument()

    fireEvent.click(within(viewer).getByRole('button', { name: 'Open in Files' }))
    await waitFor(() => {
      expect(store.getState().openFiles.t1?.activePath).toBe(HEADERS.path)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('a link’s tile', () => {
  it('shows the icon of what it is and its number, key or domain, from its address alone', async () => {
    const {
      fake: { invoke },
    } = await renderHub()

    expect(tile('Link: Document the rate limits')).toHaveTextContent(/^Document the rate limits#5097m$/)
    expect(tile('Link: /search needs its own limit')).toHaveTextContent(/^\/search needs its own limit#50224m$/)
    expect(tile('Link: Limit /search per key')).toHaveTextContent(/^Limit \/search per keyAPI-12330m$/)
    expect(tile('Link: Token buckets, explained')).toHaveTextContent(
      /^Token buckets, explainedhandbook\.example\.com19m$/,
    )
    // A different icon for each: a pull request, an issue, a ticket, a page.
    const icons = [
      'Link: Document the rate limits',
      'Link: /search needs its own limit',
      'Link: Limit /search per key',
      'Link: Token buckets, explained',
    ].map((name) => tile(name).querySelector('svg')?.getAttribute('data-icon'))
    expect(icons).toEqual(['code-pull-request', 'circle-dot', 'ticket', 'link'])
    // Nothing was fetched to know: main was never asked to open or look at a link.
    expect(invoke).not.toHaveBeenCalledWith(CommandName.LinksOpen, expect.anything())
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.FilesThumbnail)).toHaveLength(4)
  })

  it('says a pull request’s or an issue’s repository on its number, and a ticket’s or a page’s address', async () => {
    await renderHub()

    expect(within(tile('Link: Document the rate limits')).getByText('#509')).toHaveAttribute('title', '#509 · acme/api')
    expect(within(tile('Link: /search needs its own limit')).getByText('#502')).toHaveAttribute(
      'title',
      '#502 · acme/api',
    )
    expect(within(tile('Link: Limit /search per key')).getByText('API-123')).toHaveAttribute('title', TICKET)
    expect(within(tile('Link: Token buckets, explained')).getByText('handbook.example.com')).toHaveAttribute(
      'title',
      PAGE,
    )
    expect(linkTagTitle(recogniseLink(PR_509), PR_509)).toBe('#509 · acme/api')
    expect(linkTagTitle({ kind: LinkKind.Web, domain: 'example.com' }, 'https://example.com/a')).toBe(
      'https://example.com/a',
    )
  })

  it('shows a link with no recognised kind by its domain, a GitHub page that’s neither a PR nor an issue included', async () => {
    const odd = [
      hubLink('https://github.com/acme/api/actions/runs/42', 'The failing run', 3),
      hubLink('http://localhost:8000/docs', 'Local docs', 4),
      hubLink('https://www.example.com/', 'Example', 5),
    ]
    await renderHub({ artifacts: odd })

    expect(tile('Link: The failing run')).toHaveTextContent(/^The failing rungithub\.com3m$/)
    expect(tile('Link: Local docs')).toHaveTextContent(/^Local docslocalhost4m$/)
    expect(tile('Link: Example')).toHaveTextContent(/^Exampleexample\.com5m$/)
    for (const { title } of odd) {
      expect(tile(`Link: ${title}`).querySelector('svg')).toHaveAttribute('data-icon', 'link')
    }
  })

  it('shows nothing for a link the task no longer has, or a file with a link’s key', async () => {
    const wrapper = await hubStore({ artifacts: [hubFile('docs/a.md', 'A')] })
    render(
      <ArtifactTiles taskId="t1" shown={[]}>
        <ChildTile taskId="t1" kind={ChildKind.Link} childKey="docs/a.md" />
        <ChildTile taskId="t1" kind={ChildKind.Link} childKey={PAGE} />
      </ArtifactTiles>,
      { wrapper: wrapper.wrapper },
    )
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('opens in the browser, through main, on a click, ↵, Space and Open link, and never in Glade', async () => {
    const {
      main,
      store,
      fake: { invoke },
    } = await renderHub()
    const pr = tile('Link: Document the rate limits')

    fireEvent.click(within(pr).getByText('Document the rate limits'))
    fireEvent.keyDown(pr, { key: 'Enter' })
    fireEvent.keyDown(pr, { key: ' ' })
    fireEvent.click(button(pr, 'Open link'))

    await waitFor(() => {
      expect(main.opened).toEqual([PR_509, PR_509, PR_509, PR_509])
    })
    expect(invoke).not.toHaveBeenCalledWith(CommandName.FilesOpen, expect.anything())
    expect(store.getState().openFiles.t1?.paths ?? []).toEqual([])
    expect(activePanelTab(store.getState().uiState, 'w1')).not.toBe(PanelTab.Files)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has Open link, Copy link and More, in that order, and copies its address', async () => {
    const { main } = await renderHub()
    const page = tile('Link: Token buckets, explained')

    expect(
      within(page)
        .getAllByRole('button')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['Open link', 'Copy link', 'More'])

    fireEvent.click(button(page, 'Copy link'))
    await waitFor(() => {
      expect(main.copied).toEqual([PAGE])
    })
    // Copying it opened nothing.
    expect(main.opened).toEqual([])
  })

  it('says so in a toast when it can’t be opened', async () => {
    await renderHub(
      TASK,
      {},
      { [CommandName.LinksOpen]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'No browser to open it in')) },
    )

    fireEvent.click(tile('Link: Token buckets, explained'))

    expect(await screen.findByText('No browser to open it in')).toBeInTheDocument()
  })
})

describe('a tile’s context menu', () => {
  it('keeps the tile’s buttons showing while its menu is open, so More is still there to take the focus back', async () => {
    await renderHub()
    const rates = file(RATES)
    const headers = file(HEADERS)
    const more = button(rates, 'More')
    more.focus()

    fireEvent.click(more)
    await settleFloating()
    expect(screen.getByRole('menu', { name: 'Artifact actions' })).toBeInTheDocument()
    // Its own tile alone: the pointer and the focus have left it for the menu.
    expect(rates).toHaveClass(styles.pinned ?? '')
    expect(headers).not.toHaveClass(styles.pinned ?? '')
    expect(more).not.toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await settleFloating()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(more).toHaveFocus()
    expect(rates).not.toHaveClass(styles.pinned ?? '')

    // Opened for one tile, then another, it's the second's buttons that stay.
    fireEvent.contextMenu(rates)
    await act(() => Promise.resolve())
    fireEvent.contextMenu(headers)
    await act(() => Promise.resolve())
    expect(rates).not.toHaveClass(styles.pinned ?? '')
    expect(headers).toHaveClass(styles.pinned ?? '')
  })

  it('has a file’s items, as the Artifacts tab has them, from a right-click, ⇧F10 and More', async () => {
    await renderHub()
    const items = [
      'Open↵',
      'Open in editor⌘⇧E',
      'Copy contents',
      'Copy path',
      'Reveal in Finder',
      'Remove from artifacts',
    ]

    await openMenu(file(RATES))
    expect(menuItems()).toEqual(items)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(file(RATES), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(menuItems()).toEqual(items)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(() => Promise.resolve())

    // From one of its buttons too, and More opens it below itself.
    fireEvent.keyDown(button(file(RATES), 'Open'), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(menuItems()).toEqual(items)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(() => Promise.resolve())

    fireEvent.click(button(file(RATES), 'More'))
    await act(() => Promise.resolve())
    expect(menuItems()).toEqual(items)
  })

  it('opens the file in the Files tab or the editor, copies it or its path, and reveals it', async () => {
    const {
      store,
      fake: { invoke },
      main,
    } = await renderHub()

    await choose(file(RATES), 'Open')
    await waitFor(() => {
      expect(store.getState().openFiles.t1?.activePath).toBe(RATES.path)
    })
    await choose(file(RATES), 'Open in editor')
    expect(invoke).toHaveBeenCalledWith(CommandName.FilesOpenInEditor, { taskId: 't1', path: RATES.path })
    await choose(file(RATES), 'Copy contents')
    await choose(file(RATES), 'Copy path')
    await choose(file(RATES), 'Reveal in Finder')

    expect(main.copied).toEqual([RATES.path, `${sampleWorkspace('w1').rootPath}/${RATES.path}`])
    expect(main.revealed).toEqual([RATES.path])
  })

  it('has a link’s items: Open link, Copy link and Remove from artifacts', async () => {
    const { main } = await renderHub()
    const page = tile('Link: Token buckets, explained')

    await openMenu(page)
    expect(menuItems()).toEqual(['Open link↵', 'Copy link', 'Remove from artifacts'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(() => Promise.resolve())

    await choose(page, 'Open link')
    await choose(page, 'Copy link')
    await waitFor(() => {
      expect(main.opened).toEqual([PAGE])
    })
    expect(main.copied).toEqual([PAGE])
  })

  it('removes an artifact: its tile leaves the todo’s list, and the todo’s counts follow', async () => {
    const { store } = await renderHub()
    expect(pills(DOCS)).toEqual(['All 4', '3 files', '1 link'])
    expect(pills(LIMITS)).toEqual(['All 4', '1 file', '3 links'])

    await choose(file(HEADERS), 'Remove from artifacts')
    await waitFor(() => {
      expect(tiles(DOCS)).toEqual([`File: ${RATES.title}`, 'Link: Document the rate limits', `File: ${BURST.title}`])
    })
    expect(pills(DOCS)).toEqual(['All 3', '2 files', '1 link'])

    // A link, by More: the only one of the first todo's, so its kind goes from the row of icons.
    fireEvent.click(button(tile('Link: Document the rate limits'), 'More'))
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from artifacts' }))
    await waitFor(() => {
      expect(pills(DOCS)).toEqual(['All 2', '2 files'])
    })
    // The other todo is as it was, and the task has two artifacts fewer.
    expect(pills(LIMITS)).toEqual(['All 4', '1 file', '3 links'])
    expect(store.getState().artifacts.t1).toHaveLength(6)
  })

  it('leaves the todo with nothing under it once its last child is removed: its title alone', async () => {
    await renderHub({
      ...TASK,
      artifacts: [RATES],
      filings: [hubFiling(refOf.file(RATES.path), '1')],
    })

    await choose(file(RATES), 'Remove from artifacts')

    await waitFor(() => {
      expect(within(card(DOCS)).queryByRole('group')).toBeNull()
    })
    expect(within(card(DOCS)).queryByRole('button', { name: /file/ })).toBeNull()
  })

  it('closes for an artifact that’s taken off while its menu is open', async () => {
    const { fake } = await renderHub()
    await openMenu(file(RATES))

    act(() => {
      fake.emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: (TASK.artifacts ?? []).filter((each) => each !== RATES),
      })
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says so in a toast when an item fails, and the tile stays', async () => {
    await renderHub(
      TASK,
      {},
      { [CommandName.ArtifactsRemove]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'Not an artifact')) },
    )

    await choose(file(RATES), 'Remove from artifacts')

    expect(await screen.findByText('Not an artifact')).toBeInTheDocument()
    expect(file(RATES)).toBeInTheDocument()
  })

  it('is one menu for the todo’s list: a second tile’s takes the first’s place', async () => {
    await renderHub()
    // Found before a menu opens: while one is open, the rest of the window is hidden from assistive technology.
    const link = tile('Link: Document the rate limits')

    await openMenu(file(RATES))
    await openMenu(link)

    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(menuItems()).toEqual(['Open link↵', 'Copy link', 'Remove from artifacts'])
  })
})

describe('a tile outside a list', () => {
  it('can’t be: a file’s and a link’s tile take their menu and the viewer from the list around them', async () => {
    const wrapper = await hubStore({ artifacts: [RATES, hubLink(PAGE, 'Token buckets, explained')] })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => render(<FileTile taskId="t1" childKey={RATES.path} />, { wrapper: wrapper.wrapper })).toThrow(
      'must be under an ArtifactTiles',
    )
    expect(() => render(<LinkTile taskId="t1" childKey={PAGE} />, { wrapper: wrapper.wrapper })).toThrow(
      'must be under an ArtifactTiles',
    )
    error.mockRestore()
  })
})

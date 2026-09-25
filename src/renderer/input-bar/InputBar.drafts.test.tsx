// Keeping input drafts across a relaunch (#235): each task's draft is stored in main as you type, a pause after the last
// change, and at once as you switch tasks, send or quit; a bar the store has no draft for starts from main's.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandName, type DraftsGetResponse, type DraftsSetRequest } from '../../shared/bridge'
import { UiStateKey, type InputDraft, type Task } from '../../shared/domain'
import { imageDataUrl, type ImageData } from '../../shared/images'
import { GIF, PNG } from '../../shared/test-images'
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
} from '../store/test-bridge'
import { bridgeError, BridgeErrorCode } from '../../shared/bridge'
import { DRAFT_SAVE_DELAY_MS, InputBar } from './InputBar'

afterEach(() => {
  vi.useRealTimers()
})

/** What main stores, shared by every launch of a test: its drafts outlive the window, as the database does. */
interface Main {
  readonly tasks: Task[]
  readonly drafts: Record<string, InputDraft>
}

function newMain(taskCount = 2, drafts: Record<string, InputDraft> = {}): Main {
  const tasks = Array.from({ length: taskCount }, (_, index) => sampleTask(`t${String(index + 1)}`, 'w1'))
  return { tasks, drafts }
}

type Launched = FakeBridge & { store: GladeStore }

/** Opens the window on main's state with `selected` selected, as a launch or relaunch does. */
async function launch(main: Main, overrides: Partial<FakeHandlers> = {}, selected = 't1'): Promise<Launched> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: main.tasks,
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected },
      ],
      messages: [],
      drafts: main.drafts,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <InputBar />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  await act(() => Promise.resolve())
  return { ...fake, store }
}

/** Closes the window, as quitting does: it unloads, then goes. */
function quit(): void {
  act(() => {
    window.dispatchEvent(new Event('beforeunload'))
  })
  cleanup()
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message the agent' })
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } })
}

function saves(fake: FakeBridge): DraftsSetRequest[] {
  return fake.invoke.mock.calls
    .filter(([command]) => command === CommandName.DraftsSet)
    .map(([, request]) => request as DraftsSetRequest)
}

function loads(fake: FakeBridge): number {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.DraftsGet).length
}

function thumbnails(): string[] {
  const list = screen.queryByRole('list', { name: 'Attached images' })
  if (list === null) return []
  return within(list)
    .getAllByRole('img')
    .map((image) => image.getAttribute('src') ?? '')
}

function imageFile(image: ImageData): File {
  return new File([Buffer.from(image.data, 'base64')], 'image', { type: image.mediaType })
}

function pasteImages(...images: ImageData[]): void {
  const files = images.map(imageFile)
  fireEvent.paste(field(), { clipboardData: { getData: () => '', files } })
}

async function select(store: GladeStore, taskId: string): Promise<void> {
  await act(() => store.getState().selectTask(taskId))
  await act(() => Promise.resolve())
}

/** Lets the save a pause after the last change go. */
async function pause(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS)
  })
}

describe('after a relaunch', () => {
  it('gives each task back the draft it had: typed, then quit and launched again', async () => {
    const main = newMain()
    await launch(main)
    type('Check the rate limits first')
    quit()

    await launch(main)

    expect(field()).toHaveValue('Check the rate limits first')
  })

  it('gives back a draft stored a pause after typing, as after a crash, when nothing runs on the way out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    await launch(main)
    type('Half a thought')
    await pause()
    // A crash: the window goes without unloading, and without its bar closing as it would.
    expect(main.drafts).toEqual({ t1: { text: 'Half a thought', images: [] } })
    cleanup()

    await launch(main)
    expect(field()).toHaveValue('Half a thought')
  })

  it('gives back a draft’s images, in order, and stores nothing more for having restored it', async () => {
    const main = newMain(2, { t1: { text: 'See these', images: [PNG, GIF] } })
    const fake = await launch(main)

    expect(field()).toHaveValue('See these')
    expect(thumbnails()).toEqual([imageDataUrl(PNG), imageDataUrl(GIF)])
    await select(fake.store, 't2')
    expect(saves(fake)).toEqual([])
  })

  it('gives back a draft of images only', async () => {
    await launch(newMain(2, { t1: { text: '', images: [GIF] } }))
    expect(field()).toHaveValue('')
    expect(thumbnails()).toEqual([imageDataUrl(GIF)])
  })

  it('keeps a large draft whole', async () => {
    const main = newMain()
    const text = 'All the logs:\n'.concat('2026-09-25 12:00:00 GET /api/users 200 ✓\n'.repeat(25_000))
    await launch(main)
    type(text)
    quit()

    await launch(main)
    expect(field().value).toBe(text)
  })

  it('keeps many tasks’ drafts apart, and switching through them stores nothing', async () => {
    const drafts = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `t${String(index + 1)}`,
        { text: `Draft ${String(index + 1)}`, images: [] },
      ]),
    )
    const main = newMain(30, drafts)
    const fake = await launch(main)

    for (let index = 1; index <= 30; index += 1) {
      await select(fake.store, `t${String(index)}`)
      expect(field()).toHaveValue(`Draft ${String(index)}`)
    }
    // Back again, each comes from the store, without asking main.
    const asked = loads(fake)
    await select(fake.store, 't7')
    expect(field()).toHaveValue('Draft 7')
    expect(loads(fake)).toBe(asked)
    expect(saves(fake)).toEqual([])
  })

  it('leaves what you’ve started typing when the stored draft arrives after it', async () => {
    let answer: (response: DraftsGetResponse) => void = () => undefined
    const main = newMain()
    await launch(main, {
      [CommandName.DraftsGet]: () =>
        new Promise<DraftsGetResponse>((resolve) => {
          answer = resolve
        }),
    })
    type('Something new')
    await act(async () => {
      answer({ draft: { text: 'Something old', images: [PNG] } })
      await Promise.resolve()
    })

    expect(field()).toHaveValue('Something new')
    expect(thumbnails()).toEqual([])
  })

  it('starts empty when the stored draft can’t be read', async () => {
    await launch(newMain(), {
      [CommandName.DraftsGet]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk I/O error')),
    })
    expect(field()).toHaveValue('')
  })
})

describe('storing the draft', () => {
  it('stores it a pause after the last keystroke, once for a burst of them, with the last one in it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    const fake = await launch(main)
    const words = 'Check the rate limits first'
    for (let length = 1; length <= words.length; length += 1) {
      type(words.slice(0, length))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS / 4)
      })
    }
    expect(saves(fake)).toEqual([])

    await pause()
    expect(saves(fake)).toEqual([{ taskId: 't1', text: words }])
    expect(main.drafts).toEqual({ t1: { text: words, images: [] } })
    await pause()
    expect(saves(fake)).toHaveLength(1)
  })

  it('stores it at once on switching tasks, and not again after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    const fake = await launch(main)
    type('For the first task')
    await select(fake.store, 't2')

    expect(saves(fake)).toEqual([{ taskId: 't1', text: 'For the first task' }])
    await pause()
    expect(saves(fake)).toHaveLength(1)
  })

  it('stores it at once as the window unloads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fake = await launch(newMain())
    type('Before quitting')
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(saves(fake)).toEqual([{ taskId: 't1', text: 'Before quitting' }])
  })

  it('stores nothing for a draft that went back to what was stored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fake = await launch(newMain())
    type('Oops')
    type('')
    await pause()
    await select(fake.store, 't2')
    expect(saves(fake)).toEqual([])
  })

  it('removes the stored draft once it’s emptied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    const fake = await launch(main)
    type('Not this')
    await pause()
    type('')
    await pause()

    expect(saves(fake)).toEqual([
      { taskId: 't1', text: 'Not this' },
      { taskId: 't1', text: '' },
    ])
    expect(main.drafts).toEqual({})
  })

  it('removes the stored draft once it’s sent, at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    const fake = await launch(main)
    type('Ship it')
    await pause()
    expect(main.drafts).toEqual({ t1: { text: 'Ship it', images: [] } })

    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(field()).toHaveValue('')
    expect(main.drafts).toEqual({})
    expect(saves(fake).at(-1)).toEqual({ taskId: 't1', text: '' })
    cleanup()

    await launch(main)
    expect(field()).toHaveValue('')
  })

  it('removes it when it’s sent before its save went, and a save on its way doesn’t bring it back', async () => {
    let sent: () => void = () => undefined
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const main = newMain()
    const fake = await launch(main, {
      [CommandName.TasksSend]: () =>
        new Promise((resolve) => {
          sent = () => {
            resolve({ message: {} as never })
          }
        }),
    })
    type('Ship it')
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter' })
      await Promise.resolve()
    })
    // The save's pause ends while the message is on its way.
    await pause()
    expect(main.drafts).toEqual({ t1: { text: 'Ship it', images: [] } })
    await act(async () => {
      sent()
      await Promise.resolve()
    })

    expect(main.drafts).toEqual({})
    expect(saves(fake).at(-1)).toEqual({ taskId: 't1', text: '' })
  })

  it('removes it when it’s sent while you’re on another task, which doesn’t bring it back', async () => {
    let sent: () => void = () => undefined
    const main = newMain()
    const fake = await launch(main, {
      [CommandName.TasksSend]: () =>
        new Promise((resolve) => {
          sent = () => {
            resolve({ message: {} as never })
          }
        }),
    })
    type('Ship it')
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter' })
      await Promise.resolve()
    })
    await select(fake.store, 't2')
    expect(main.drafts).toEqual({ t1: { text: 'Ship it', images: [] } })
    await act(async () => {
      sent()
      await Promise.resolve()
    })

    expect(main.drafts).toEqual({})
    await select(fake.store, 't1')
    expect(field()).toHaveValue('')
  })

  it('stores images with the draft only when they change', async () => {
    const main = newMain()
    const fake = await launch(main)
    pasteImages(PNG, GIF)
    await waitFor(() => {
      expect(saves(fake)).toEqual([{ taskId: 't1', text: '', images: [PNG, GIF] }])
    })

    type('Why does it look like this?')
    await waitFor(() => {
      expect(saves(fake)).toHaveLength(2)
    })
    expect(saves(fake)[1]).toEqual({ taskId: 't1', text: 'Why does it look like this?' })
    expect(main.drafts).toEqual({ t1: { text: 'Why does it look like this?', images: [PNG, GIF] } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    await waitFor(() => {
      expect(saves(fake)).toHaveLength(3)
    })
    expect(main.drafts).toEqual({ t1: { text: 'Why does it look like this?', images: [GIF] } })
    quit()

    await launch(main)
    expect(field()).toHaveValue('Why does it look like this?')
    expect(thumbnails()).toEqual([imageDataUrl(GIF)])
  })

  it('numbers images pasted after a restored one on from it', async () => {
    const main = newMain(2, { t1: { text: '', images: [PNG] } })
    const fake = await launch(main)
    pasteImages(GIF)
    await waitFor(() => {
      expect(thumbnails()).toEqual([imageDataUrl(PNG), imageDataUrl(GIF)])
    })
    await waitFor(() => {
      expect(saves(fake)).toEqual([{ taskId: 't1', text: '', images: [PNG, GIF] }])
    })
  })

  it('carries on when a save fails: the draft stays in the bar, and the next save carries it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let failing = true
    const main = newMain()
    const fake = await launch(main, {
      [CommandName.DraftsSet]: (change) => {
        if (failing) return refuse(bridgeError(BridgeErrorCode.Internal, 'database is locked'))
        main.drafts[change.taskId] = { text: change.text, images: change.images ?? [] }
        return null
      },
    })
    type('Keep this')
    await pause()
    expect(main.drafts).toEqual({})
    expect(field()).toHaveValue('Keep this')

    failing = false
    type('Keep this too')
    await pause()
    expect(saves(fake)).toHaveLength(2)
    expect(main.drafts).toEqual({ t1: { text: 'Keep this too', images: [] } })
  })
})

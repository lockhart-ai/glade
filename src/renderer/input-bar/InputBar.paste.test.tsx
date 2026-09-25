// Pasting into the input bar (P9-07): text is left to the field; images are attached as thumbnails and go with the
// message; anything else is refused, saying why.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { imageDataUrl, MAX_IMAGE_BYTES, type ImageData } from '../../shared/images'
import { GIF, JPEG, PNG, WEBP } from '../../shared/test-images'
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
import { IMAGE_LABEL } from '../images/StoredImage'
import { ASKING_IMAGES_REFUSAL, InputBar } from './InputBar'

interface Setup {
  readonly task?: Partial<Task>
  readonly overrides?: Partial<FakeHandlers>
}

type Rendered = FakeBridge & { store: GladeStore }

async function renderBar({ task = {}, overrides = {} }: Setup = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...sampleTask('t1', 'w1'), ...task }, sampleTask('t2', 'w1', 'Fix flaky login test')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [],
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
  return { ...fake, store }
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message the agent' })
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } })
}

/** A pasted file of an image's bytes. */
function imageFile(image: ImageData, name = 'image.png'): File {
  return new File([Buffer.from(image.data, 'base64')], name, { type: image.mediaType })
}

interface Clipboard {
  readonly text?: string
  readonly html?: string
  readonly files?: readonly File[]
}

/** Pastes into the message field; answers whether the field's own paste went ahead. */
function paste({ text = '', html = '', files = [] }: Clipboard): boolean {
  const data: Readonly<Record<string, string>> = { 'text/plain': text, 'text/html': html }
  return fireEvent.paste(field(), { clipboardData: { getData: (format: string) => data[format] ?? '', files } })
}

/** The attached images, as their sources, in order. */
function thumbnails(): string[] {
  const list = screen.queryByRole('list', { name: 'Attached images' })
  if (list === null) return []
  return within(list)
    .getAllByRole('img')
    .map((image) => image.getAttribute('src') ?? '')
}

async function attached(count: number): Promise<void> {
  await waitFor(() => {
    expect(thumbnails()).toHaveLength(count)
  })
}

function refusals(): string[] {
  return screen.queryAllByRole('alert').map((alert) => alert.textContent)
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field(), { key: 'Enter' })
    await Promise.resolve()
  })
}

function requests(fake: FakeBridge, command: CommandName): unknown[] {
  return fake.invoke.mock.calls.filter(([name]) => name === command).map(([, request]) => request)
}

describe('pasting text', () => {
  it('leaves it to the field, which inserts it at the caret as plain text, and attaches nothing', async () => {
    await renderBar()

    expect(paste({ text: 'Line one\nLine two', html: '<b>Line one</b><br>Line two' })).toBe(true)
    expect(thumbnails()).toEqual([])
  })

  it('takes a paste of text with a picture of it alongside as text', async () => {
    await renderBar()

    expect(paste({ text: 'Q3 totals', files: [imageFile(PNG)] })).toBe(true)
    await act(() => Promise.resolve())
    expect(thumbnails()).toEqual([])
  })

  it('leaves an empty paste to the field too', async () => {
    await renderBar()
    expect(paste({})).toBe(true)
  })
})

describe('pasting images', () => {
  it('attaches a pasted image as a thumbnail with a remove button, instead of pasting into the field', async () => {
    await renderBar()
    type('Why does it look like this?')

    expect(paste({ files: [imageFile(PNG)] })).toBe(false)
    await attached(1)

    expect(thumbnails()).toEqual([imageDataUrl(PNG)])
    expect(screen.getByRole('img', { name: 'Pasted image 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove image 1' })).toHaveAttribute('title', 'Remove image')
    expect(field()).toHaveValue('Why does it look like this?')
    expect(refusals()).toEqual([])
  })

  it('sends the text and the images together, then clears both', async () => {
    const fake = await renderBar()
    type('  Why does it look like this?  ')
    paste({ files: [imageFile(PNG)] })
    await attached(1)

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([
      { id: 't1', text: 'Why does it look like this?', images: [PNG] },
    ])
    expect(field()).toHaveValue('')
    expect(thumbnails()).toEqual([])
  })

  it('attaches several images pasted at once, in order, of every supported type', async () => {
    const fake = await renderBar()

    paste({ files: [imageFile(PNG), imageFile(JPEG, 'b.jpg'), imageFile(GIF, 'c.gif'), imageFile(WEBP, 'd.webp')] })
    await attached(4)

    expect(thumbnails()).toEqual([PNG, JPEG, GIF, WEBP].map(imageDataUrl))
    type('Four states.')
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([
      { id: 't1', text: 'Four states.', images: [PNG, JPEG, GIF, WEBP] },
    ])
  })

  it('adds each paste’s images after the ones already attached', async () => {
    await renderBar()

    paste({ files: [imageFile(GIF)] })
    await attached(1)
    paste({ files: [imageFile(PNG), imageFile(PNG)] })
    await attached(3)

    expect(thumbnails()).toEqual([GIF, PNG, PNG].map(imageDataUrl))
  })

  it('removes one of several images, keeping the others in order, and sends only those', async () => {
    const fake = await renderBar()
    paste({ files: [imageFile(PNG), imageFile(JPEG), imageFile(GIF)] })
    await attached(3)

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 2' }))

    expect(thumbnails()).toEqual([PNG, GIF].map(imageDataUrl))
    expect(field()).toHaveFocus()
    // The rest are renumbered.
    expect(screen.getByRole('button', { name: 'Remove image 2' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove image 3' })).toBeNull()

    type('These two.')
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([{ id: 't1', text: 'These two.', images: [PNG, GIF] }])
  })

  it('removes the last image, leaving no thumbnails', async () => {
    await renderBar()
    paste({ files: [imageFile(PNG)] })
    await attached(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))

    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull()
  })

  it('sends a message that is only images', async () => {
    const fake = await renderBar()
    paste({ files: [imageFile(JPEG)] })
    await attached(1)

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([{ id: 't1', text: '', images: [JPEG] }])
    expect(thumbnails()).toEqual([])
  })

  it('still sends nothing for a blank message without images', async () => {
    const fake = await renderBar()
    type('  ')
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([])
  })

  it('queues the images with the message while the agent works', async () => {
    const fake = await renderBar({ task: { activity: TaskActivity.Working } })
    paste({ files: [imageFile(PNG), imageFile(GIF)] })
    await attached(2)
    type('Use these.')

    await send()

    expect(requests(fake, CommandName.QueueAdd)).toEqual([{ taskId: 't1', text: 'Use these.', images: [PNG, GIF] }])
    expect(requests(fake, CommandName.TasksSend)).toEqual([])
    expect(thumbnails()).toEqual([])
  })

  it('shows a queued message’s images as small thumbnails in its row, and keeps them when its text is edited', async () => {
    const fake = await renderBar({ task: { activity: TaskActivity.Working } })
    paste({ files: [imageFile(PNG), imageFile(GIF)] })
    await attached(2)
    type('Use these.')
    await send()
    await act(() => Promise.resolve())

    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const row = (): HTMLElement => within(queue).getAllByRole('listitem')[0] ?? queue
    const sources = (): (string | null)[] =>
      within(row())
        .getAllByRole('img', { name: IMAGE_LABEL })
        .map((image) => image.getAttribute('src'))
    expect(sources()).toEqual([imageDataUrl(PNG), imageDataUrl(GIF)])
    expect(row()).toHaveTextContent('Use these.')

    const [queued] = fake.store.getState().queuedMessages.t1 ?? []
    await act(() => fake.store.getState().editQueuedMessage(queued?.id ?? '', 'Use these two.'))
    await act(() => Promise.resolve())
    expect(row()).toHaveTextContent('Use these two.')
    expect(sources()).toEqual([imageDataUrl(PNG), imageDataUrl(GIF)])
  })

  it('queues them instead when the agent started working since the bar last heard', async () => {
    const fake = await renderBar({
      overrides: {
        [CommandName.TasksSend]: () => refuse(bridgeError(BridgeErrorCode.Busy, 'The agent is working')),
      },
    })
    paste({ files: [imageFile(WEBP)] })
    await attached(1)

    await send()

    expect(requests(fake, CommandName.QueueAdd)).toEqual([{ taskId: 't1', text: '', images: [WEBP] }])
    expect(thumbnails()).toEqual([])
  })

  it('keeps the text and images when sending fails, and says why', async () => {
    const fake = await renderBar({
      overrides: {
        [CommandName.TasksSend]: () => refuse(bridgeError(BridgeErrorCode.InvalidRequest, 'Too much')),
      },
    })
    type('Look.')
    paste({ files: [imageFile(PNG)] })
    await attached(1)

    await send()

    expect(requests(fake, CommandName.TasksSend)).toHaveLength(1)
    expect(field()).toHaveValue('Look.')
    expect(thumbnails()).toEqual([imageDataUrl(PNG)])
    expect(await screen.findByText(/Couldn’t send your message/)).toBeInTheDocument()
  })

  it('keeps each task’s attachments with its draft, and gives them back when the task comes back', async () => {
    const fake = await renderBar()
    paste({ files: [imageFile(PNG)] })
    await attached(1)

    await act(() => fake.store.getState().selectTask('t2'))
    expect(thumbnails()).toEqual([])
    await act(() => fake.store.getState().selectTask('t1'))
    expect(thumbnails()).toEqual([imageDataUrl(PNG)])

    // One pasted after the kept one is told apart from it.
    paste({ files: [imageFile(GIF, 'wave.gif')] })
    await attached(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(thumbnails()).toEqual([imageDataUrl(GIF)])
  })
})

describe('refusing what can’t be attached', () => {
  it('refuses a file that isn’t a supported image, saying why, and attaches nothing', async () => {
    await renderBar()

    expect(paste({ files: [new File(['II*'], 'scan.tiff', { type: 'image/tiff' })] })).toBe(false)

    await waitFor(() => {
      expect(refusals()).toEqual(['scan.tiff can’t be attached: only PNG, JPEG, GIF and WebP images can.'])
    })
    expect(thumbnails()).toEqual([])
  })

  it('refuses an image over the size limit, saying what the limit is', async () => {
    await renderBar()

    paste({ files: [new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.png', { type: 'image/png' })] })

    await waitFor(() => {
      expect(refusals()).toEqual(['huge.png is too large: images can be up to 3.75 MB.'])
    })
    expect(thumbnails()).toEqual([])
  })

  it('attaches what it can from a mixed paste, and says why it left out each of the rest', async () => {
    await renderBar()

    paste({
      files: [
        imageFile(PNG),
        new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }),
        imageFile(GIF),
        new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' }),
      ],
    })
    await attached(2)

    expect(thumbnails()).toEqual([PNG, GIF].map(imageDataUrl))
    expect(refusals()).toEqual([
      'notes.pdf can’t be attached: only PNG, JPEG, GIF and WebP images can.',
      'huge.jpg is too large: images can be up to 3.75 MB.',
    ])
  })

  it('shows only the last paste’s refusals, and clears them on removing an image or sending', async () => {
    await renderBar()
    const tiff = (): File => new File(['II*'], 'scan.tiff', { type: 'image/tiff' })

    paste({ files: [tiff(), tiff()] })
    await waitFor(() => {
      expect(refusals()).toHaveLength(2)
    })
    paste({ files: [imageFile(PNG), imageFile(GIF)] })
    await attached(2)
    expect(refusals()).toEqual([])

    paste({ files: [tiff()] })
    await waitFor(() => {
      expect(refusals()).toHaveLength(1)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(refusals()).toEqual([])

    paste({ files: [tiff()] })
    await waitFor(() => {
      expect(refusals()).toHaveLength(1)
    })
    await send()
    expect(refusals()).toEqual([])
  })

  it('refuses to send images as an answer to the agent’s questions, keeping them and the text', async () => {
    const fake = await renderBar({ task: { asking: true } })
    type('This layout.')
    paste({ files: [imageFile(PNG)] })
    await attached(1)

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([])
    expect(refusals()).toEqual([ASKING_IMAGES_REFUSAL])
    expect(field()).toHaveValue('This layout.')
    expect(thumbnails()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([{ id: 't1', text: 'This layout.' }])
  })
})

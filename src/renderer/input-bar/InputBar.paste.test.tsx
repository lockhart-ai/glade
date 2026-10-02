// Pasting into the input bar (P9-07): text is left to the field; images are attached as thumbnails and go with the
// message; anything else is refused, saying why.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type PastedBlock, type Task } from '../../shared/domain'
import { imageDataUrl, MAX_IMAGE_BYTES, type ImageData } from '../../shared/images'
import { PASTE_LENGTH_THRESHOLD, pasteToken } from '../../shared/pastedContent'
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
import { settleFloating } from '../components/settleFloating'
import { VIEWER_LABEL } from '../images/ImageViewer'
import { IMAGE_LABEL } from '../images/StoredImage'
import { ASKING_ATTACHMENTS_REFUSAL, InputBar } from './InputBar'

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

/** The pasted-text chips above the field, as their labels, in order. */
function chips(): string[] {
  const list = screen.queryByRole('list', { name: 'Pasted text' })
  if (list === null) return []
  return within(list)
    .getAllByRole('button', { expanded: false })
    .map((button) => button.textContent)
}

async function chipped(count: number): Promise<void> {
  await waitFor(() => {
    expect(chips()).toHaveLength(count)
  })
}

describe('pasting text', () => {
  it('leaves a short single line to the field, which inserts it at the caret as plain text', async () => {
    await renderBar()

    const path = '/code/acme-api/src/main.ts'
    expect(paste({ text: path, html: `<b>${path}</b>` })).toBe(true)
    expect(chips()).toEqual([])
  })

  it('leaves a single line right under the threshold to the field too', async () => {
    await renderBar()

    expect(paste({ text: 'x'.repeat(PASTE_LENGTH_THRESHOLD - 1) })).toBe(true)
    expect(chips()).toEqual([])
  })

  it('takes a paste of text with a picture of it alongside as text', async () => {
    await renderBar()

    expect(paste({ text: 'Q3 totals', files: [imageFile(PNG)] })).toBe(true)
    await act(() => Promise.resolve())
    expect(thumbnails()).toEqual([])
    expect(chips()).toEqual([])
  })

  it('leaves an empty paste to the field too', async () => {
    await renderBar()
    expect(paste({})).toBe(true)
  })
})

describe('pasted text blocks', () => {
  const trace = 'Traceback (most recent call last)\nKeyError: user_id'

  /** The message field's pasted blocks, as main got them (they carry the request's random ids). */
  function pastedBlocksSent(fake: FakeBridge, command: CommandName): readonly PastedBlock[] {
    const [request] = requests(fake, command) as { pastedBlocks?: readonly PastedBlock[] }[]
    return request?.pastedBlocks ?? []
  }

  it('marks a paste of more than one line as a pasted block, instead of pasting it into the field', async () => {
    await renderBar()

    expect(paste({ text: trace })).toBe(false)
    await chipped(1)

    expect(chips()).toEqual(['Pasted text · 2 lines'])
    // The field keeps only a short inline token: the pasted text itself is never dumped into it.
    expect(field()).toHaveValue(pasteToken(trace))
    expect(field().value).not.toContain('Traceback')
    expect(refusals()).toEqual([])

    // The token is highlighted behind the field (styling only), and the highlight goes with the token when removed.
    expect(screen.getByTestId('paste-highlight-overlay').querySelectorAll('mark')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }))
    expect(screen.getByTestId('paste-highlight-overlay').querySelectorAll('mark')).toHaveLength(0)
  })

  it('marks a single line at the threshold as a pasted block too', async () => {
    await renderBar()
    const line = 'x'.repeat(PASTE_LENGTH_THRESHOLD)

    expect(paste({ text: line })).toBe(false)
    await chipped(1)

    expect(chips()).toEqual(['Pasted text · 1 line'])
    expect(field()).toHaveValue(pasteToken(line))
  })

  it('sends the token in the text, and the pasted block with its own random id, distinctly from each other', async () => {
    const fake = await renderBar()
    type("Here's the error: ")
    paste({ text: trace })
    await chipped(1)
    type(`Here's the error: ${pasteToken(trace)} any ideas?`)

    await send()

    const [request] = requests(fake, CommandName.TasksSend) as {
      id: string
      text: string
      pastedBlocks: PastedBlock[]
    }[]
    expect(request?.text).toBe(`Here's the error: ${pasteToken(trace)} any ideas?`)
    expect(request?.pastedBlocks).toEqual([{ id: expect.any(String) as string, text: trace }])
    expect(request?.text).not.toContain('<pasted_content')
    expect(field()).toHaveValue('')
    expect(chips()).toEqual([])
  })

  it('keeps several blocks in order, each with its own id, sent in their place among the typed text', async () => {
    const fake = await renderBar()
    const other = 'first\nsecond'

    paste({ text: trace })
    await chipped(1)
    type(`${pasteToken(trace)} and `)
    paste({ text: other })
    await chipped(2)

    expect(chips()).toEqual(['Pasted text · 2 lines', 'Pasted text · 2 lines'])
    expect(field()).toHaveValue(`${pasteToken(trace)} and ${pasteToken(other)}`)

    await send()
    const blocks = pastedBlocksSent(fake, CommandName.TasksSend)
    expect(blocks.map(({ text }) => text)).toEqual([trace, other])
    expect(new Set(blocks.map(({ id }) => id)).size).toBe(2)
  })

  it('removes a chip with its remove button, taking its token out of the field too', async () => {
    await renderBar()
    type('Before. ')
    paste({ text: trace })
    await chipped(1)
    type(`Before. ${pasteToken(trace)} After.`)

    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }))

    expect(chips()).toEqual([])
    expect(field()).toHaveValue('Before.  After.')
    expect(field()).toHaveFocus()
  })

  it('removes a block atomically with Backspace right after its token, in one keystroke', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)
    type(`Before ${pasteToken(trace)}`)
    const position = field().value.length
    field().setSelectionRange(position, position)

    fireEvent.keyDown(field(), { key: 'Backspace' })

    expect(chips()).toEqual([])
    expect(field()).toHaveValue('Before ')
  })

  it('removes a block atomically with Delete right before its token', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)
    type(`${pasteToken(trace)} after`)
    field().setSelectionRange(0, 0)

    fireEvent.keyDown(field(), { key: 'Delete' })

    expect(chips()).toEqual([])
    expect(field()).toHaveValue(' after')
  })

  it('drops a block whose token gets typed into, keeping the rest of the edit', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)
    const withToken = pasteToken(trace)
    // Overwrite the middle of the token with something else, as a selection replaced by typing would.
    const mangled = `${withToken.slice(0, 5)}X${withToken.slice(6)}`
    type(mangled)

    expect(chips()).toEqual([])
    expect(field()).toHaveValue(mangled)
  })

  it('expands a chip to show and edit its text, regenerating its token’s line count', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    const editor = screen.getByRole('textbox', { name: 'Pasted text' })
    expect(editor).toHaveValue(trace)

    const longer = `${trace}\nmore context`
    fireEvent.change(editor, { target: { value: longer } })
    fireEvent.click(screen.getByRole('button', { name: 'Save pasted text' }))

    expect(chips()).toEqual(['Pasted text · 3 lines'])
    expect(field()).toHaveValue(pasteToken(longer))
  })

  it('cancels an edit with its cancel button, keeping the block as it was', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pasted text' }), { target: { value: 'Something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing pasted text' }))

    expect(chips()).toEqual(['Pasted text · 2 lines'])
    expect(field()).toHaveValue(pasteToken(trace))
  })

  it('cancels an edit with Escape too', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pasted text' }), { target: { value: 'Something else' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Pasted text' }), { key: 'Escape' })

    expect(chips()).toEqual(['Pasted text · 2 lines'])
    expect(field()).toHaveValue(pasteToken(trace))
  })

  it('leaves other keys in the editor alone', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Pasted text' }), { key: 'Enter' })

    expect(screen.getByRole('textbox', { name: 'Pasted text' })).toBeInTheDocument()
  })

  it('saving with no change, or with the text emptied, just collapses the chip back', async () => {
    await renderBar()
    paste({ text: trace })
    await chipped(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save pasted text' }))
    expect(chips()).toEqual(['Pasted text · 2 lines'])
    expect(field()).toHaveValue(pasteToken(trace))

    fireEvent.click(screen.getByRole('button', { name: 'Pasted text · 2 lines' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pasted text' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save pasted text' }))
    expect(chips()).toEqual(['Pasted text · 2 lines'])
    expect(field()).toHaveValue(pasteToken(trace))
  })

  it('queues a pasted block with the message while the agent works', async () => {
    const fake = await renderBar({ task: { activity: TaskActivity.Working } })
    paste({ text: trace })
    await chipped(1)
    type(`See this: ${pasteToken(trace)}`)

    await send()

    const blocks = pastedBlocksSent(fake, CommandName.QueueAdd)
    expect(blocks).toEqual([{ id: expect.any(String) as string, text: trace }])
    expect(requests(fake, CommandName.TasksSend)).toEqual([])
    expect(chips()).toEqual([])

    // The queue's row shows the token (never the pasted text itself, dumped in): the same design as the field.
    await act(() => Promise.resolve())
    const row = within(screen.getByRole('region', { name: 'Queued messages' })).getAllByRole('listitem')[0]
    expect(row).toHaveTextContent(`See this: ${pasteToken(trace)}`)
  })

  it('refuses to send pasted text as an answer to the agent’s questions, keeping it and the text', async () => {
    const fake = await renderBar({ task: { asking: true } })
    type('This one: ')
    paste({ text: trace })
    await chipped(1)
    type(`This one: ${pasteToken(trace)}`)

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([])
    expect(refusals()).toEqual([ASKING_ATTACHMENTS_REFUSAL])
    expect(chips()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }))
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([{ id: 't1', text: 'This one:' }])
  })

  it('keeps each task’s pasted blocks with its draft, apart from another task’s', async () => {
    const fake = await renderBar()
    paste({ text: trace })
    await chipped(1)

    await act(() => fake.store.getState().selectTask('t2'))
    expect(chips()).toEqual([])
    await act(() => fake.store.getState().selectTask('t1'))
    expect(chips()).toEqual(['Pasted text · 2 lines'])
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

  it('opens a queued message’s thumbnail in the image viewer, whose keys and right-clicks aren’t the row’s', async () => {
    await renderBar({ task: { activity: TaskActivity.Working } })
    paste({ files: [imageFile(PNG), imageFile(GIF)] })
    await attached(2)
    type('Use these.')
    await send()
    await act(() => Promise.resolve())

    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const thumbnail = within(queue).getByRole('button', { name: 'View pasted image 2 of 2' })
    thumbnail.focus()
    fireEvent.click(thumbnail)
    await settleFloating()
    const viewer = screen.getByRole('dialog', { name: VIEWER_LABEL })
    expect(within(viewer).getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(GIF))

    // The row's context menu stays shut: the viewer is rendered from inside the row, but isn't in it on the page.
    fireEvent.contextMenu(within(viewer).getByRole('img', { name: IMAGE_LABEL }))
    fireEvent.keyDown(viewer, { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu', { name: 'Queued message actions' })).not.toBeInTheDocument()

    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(within(viewer).getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(PNG))
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close image' }))
    await settleFloating()
    await act(() => Promise.resolve())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Closing it puts the focus on the task's input (#415), not back on the thumbnail that opened it.
    expect(field()).toHaveFocus()
    expect(within(queue).getAllByRole('listitem')).toHaveLength(1)
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
    expect(refusals()).toEqual([ASKING_ATTACHMENTS_REFUSAL])
    expect(field()).toHaveValue('This layout.')
    expect(thumbnails()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    await send()
    expect(requests(fake, CommandName.TasksSend)).toEqual([{ id: 't1', text: 'This layout.' }])
  })
})

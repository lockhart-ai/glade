// Attaching files to the message being written (#396): dropped onto the input bar, or pasted from Finder, each is
// copied into the workspace by main and shown as a chip; it goes with the message, and its draft keeps it.
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { AttachedFileKind, type AttachedFile } from '../../shared/attachedFiles'
import { TaskActivity, UiStateKey, type InputDraft, type QueuedMessage, type Task } from '../../shared/domain'
import { PNG } from '../../shared/test-images'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  fileOnDisk,
  refuse,
  sampleAttachedFile,
  sampleQueuedMessage,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { REVEAL_TITLE } from '../attached-files/FileChip'
import { ASKING_ATTACHMENTS_REFUSAL, attachFailureMessage, InputBar } from './InputBar'

interface Setup {
  readonly task?: Partial<Task>
  readonly overrides?: Partial<FakeHandlers>
  readonly drafts?: Record<string, InputDraft>
  readonly queued?: QueuedMessage[]
}

type Rendered = FakeBridge & { store: GladeStore }

async function renderBar({ task = {}, overrides = {}, drafts, queued }: Setup = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...sampleTask('t1', 'w1'), ...task }, sampleTask('t2', 'w1', 'Fix flaky login test')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [],
      ...(drafts === undefined ? {} : { drafts }),
      ...(queued === undefined ? {} : { queuedMessages: queued }),
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

function bar(): HTMLElement {
  const element = field().closest('[class*="bar"]')
  if (!(element instanceof HTMLElement)) throw new Error('No input bar')
  return element
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } })
}

/** A drag's data carrying files, as Finder's does. */
function dragData(files: readonly File[], types: readonly string[] = ['Files']): object {
  return { dataTransfer: { types, files, dropEffect: 'none' } }
}

/** Drops files onto the input bar, as dragging them from Finder does. Answers whether the bar took the drop. */
async function drop(files: readonly File[], types?: readonly string[]): Promise<boolean> {
  let taken = false
  await act(async () => {
    fireEvent.dragEnter(bar(), dragData(files, types))
    fireEvent.dragOver(bar(), dragData(files, types))
    taken = !fireEvent.drop(bar(), dragData(files, types))
    await Promise.resolve()
  })
  return taken
}

/** The drag leaves the bar's element for `to` (jsdom's events don't carry a related target of their own). */
function leave(to: Element): void {
  const event = createEvent.dragLeave(bar(), dragData([]))
  Object.defineProperty(event, 'relatedTarget', { value: to })
  fireEvent(bar(), event)
}

/** Pastes into the field, as ⌘V does; answers whether the field's own paste went ahead. */
function paste(text: string, files: readonly File[]): boolean {
  const data: Readonly<Record<string, string>> = { 'text/plain': text }
  return fireEvent.paste(field(), { clipboardData: { getData: (format: string) => data[format] ?? '', files } })
}

/** The attached files' chips, as their names, in order. */
function chips(): string[] {
  const list = screen.queryByRole('list', { name: 'Attached files' })
  if (list === null) return []
  return within(list)
    .getAllByTitle(REVEAL_TITLE)
    .map((chip) => chip.querySelector('[class*="name"]')?.textContent ?? '')
}

async function attachedFiles(names: readonly string[]): Promise<void> {
  await waitFor(() => {
    expect(chips()).toEqual(names)
  })
}

function requests(fake: FakeBridge, command: CommandName): unknown[] {
  return fake.invoke.mock.calls.filter(([name]) => name === command).map(([, request]) => request)
}

function toasts(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' })
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field(), { key: 'Enter' })
    await Promise.resolve()
  })
}

const SALES = '/tmp/Desktop/sales.csv'
const POLICY = '/tmp/Desktop/retention policy.pdf'

describe('dropping files onto the input bar', () => {
  it('copies each into the workspace through main, in order, and shows a chip with its name, type and size', async () => {
    const fake = await renderBar()

    expect(await drop([fileOnDisk(SALES), fileOnDisk(POLICY)])).toBe(true)

    await attachedFiles(['sales.csv', 'retention policy.pdf'])
    expect(requests(fake, CommandName.AttachmentsAdd)).toEqual([
      { taskId: 't1', path: SALES },
      { taskId: 't1', path: POLICY },
    ])
    expect(screen.getByRole('button', { name: 'sales.csv, CSV · 48 KB' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'retention policy.pdf, PDF · 48 KB' })).toBeInTheDocument()
    expect(field()).toHaveFocus()
  })

  it('marks the bar while files are dragged over it, and not once they leave or drop', async () => {
    await renderBar()
    fireEvent.dragEnter(bar(), dragData([fileOnDisk(SALES)]))
    expect(bar()).toHaveAttribute('data-dropping')

    // Moving onto the field, inside the bar, keeps it marked.
    leave(field())
    expect(bar()).toHaveAttribute('data-dropping')

    leave(document.body)
    expect(bar()).not.toHaveAttribute('data-dropping')

    fireEvent.dragOver(bar(), dragData([fileOnDisk(SALES)]))
    await drop([fileOnDisk(SALES)])
    expect(bar()).not.toHaveAttribute('data-dropping')
  })

  it('leaves a drag of text alone: nothing is attached, and the field takes it as it would', async () => {
    const fake = await renderBar()
    expect(await drop([], ['text/plain'])).toBe(false)
    expect(bar()).not.toHaveAttribute('data-dropping')
    expect(requests(fake, CommandName.AttachmentsAdd)).toEqual([])
  })

  it('clears why the last paste wasn’t attached once files are dropped', async () => {
    await renderBar()
    act(() => {
      paste('', [new File(['II*'], 'scan.tiff', { type: 'image/tiff' })])
    })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('scan.tiff can’t be attached')
    })

    await drop([fileOnDisk(SALES)])

    await attachedFiles(['sales.csv'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('attaches an image dropped from an app, not a file on disk, as a thumbnail, as a pasted one is', async () => {
    const fake = await renderBar()
    const image = new File([Buffer.from(PNG.data, 'base64')], 'image.png', { type: PNG.mediaType })

    await drop([image, fileOnDisk(SALES)])

    await attachedFiles(['sales.csv'])
    await waitFor(() => {
      expect(within(screen.getByRole('list', { name: 'Attached images' })).getAllByRole('img')).toHaveLength(1)
    })
    expect(requests(fake, CommandName.AttachmentsAdd)).toEqual([{ taskId: 't1', path: SALES }])
  })

  it('says why in a toast when main refuses a file, in its own words, and attaches the rest', async () => {
    await renderBar({
      overrides: {
        [CommandName.AttachmentsAdd]: ({ taskId, path }) =>
          path.endsWith('reports')
            ? refuse(
                bridgeError(
                  BridgeErrorCode.InvalidRequest,
                  'attachments.add: reports is a folder: only files can be attached for now.',
                ),
              )
            : { file: sampleAttachedFile(taskId, path) },
      },
    })

    await drop([fileOnDisk('/tmp/Desktop/reports'), fileOnDisk(SALES)])

    await attachedFiles(['sales.csv'])
    expect(toasts()).toHaveTextContent('reports is a folder: only files can be attached for now.')
    expect(toasts()).not.toHaveTextContent('attachments.add')
  })
})

describe('attachFailureMessage', () => {
  it('says main’s own words for a refusal, and which file and what went wrong for anything else', () => {
    expect(
      attachFailureMessage(
        '/tmp/huge.bin',
        bridgeError(BridgeErrorCode.InvalidRequest, 'attachments.add: huge.bin is too large to attach'),
      ),
    ).toBe('huge.bin is too large to attach')
    expect(attachFailureMessage('/tmp/x', bridgeError(BridgeErrorCode.InvalidRequest, 'x is a folder'))).toBe(
      'x is a folder',
    )
    expect(attachFailureMessage('/tmp/Desktop/sales.csv', new Error('disk full'))).toBe(
      'Couldn’t attach sales.csv: disk full',
    )
  })
})

describe('pasting files copied in Finder', () => {
  it('attaches them, even with the names Finder puts beside them as text', async () => {
    const fake = await renderBar()
    type('Check these')

    let pasted = true
    act(() => {
      pasted = paste('sales.csv\nretention policy.pdf', [fileOnDisk(SALES), fileOnDisk(POLICY)])
    })

    expect(pasted).toBe(false)
    await attachedFiles(['sales.csv', 'retention policy.pdf'])
    expect(field()).toHaveValue('Check these')
    expect(requests(fake, CommandName.AttachmentsAdd)).toHaveLength(2)
  })

  it('leaves a paste of text with no file on disk to the field', async () => {
    const fake = await renderBar()
    const image = new File(['not on disk'], 'image.png', { type: 'image/png' })
    let pasted = false
    act(() => {
      pasted = paste('a word', [image])
    })
    expect(pasted).toBe(true)
    expect(requests(fake, CommandName.AttachmentsAdd)).toEqual([])
  })
})

describe('a file’s chip', () => {
  it('reveals the copy in Finder when clicked', async () => {
    const fake = await renderBar()
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    fireEvent.click(screen.getByRole('button', { name: 'sales.csv, CSV · 48 KB' }))

    expect(requests(fake, CommandName.FilesReveal)).toEqual([{ taskId: 't1', path: '.glade/attachments/t1/sales.csv' }])
  })

  it('says so in a toast when the copy can’t be shown', async () => {
    await renderBar({
      overrides: { [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file')) },
    })
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    fireEvent.click(screen.getByRole('button', { name: 'sales.csv, CSV · 48 KB' }))

    await waitFor(() => {
      expect(toasts()).toHaveTextContent('Couldn’t show sales.csv in Finder: No file')
    })
  })

  it('takes the file off with ✕, deleting its copy through main, and keeps the rest', async () => {
    const fake = await renderBar()
    await drop([fileOnDisk(SALES), fileOnDisk(POLICY)])
    await attachedFiles(['sales.csv', 'retention policy.pdf'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove sales.csv' }))

    expect(chips()).toEqual(['retention policy.pdf'])
    expect(requests(fake, CommandName.AttachmentsDiscard)).toEqual([
      { taskId: 't1', path: '.glade/attachments/t1/sales.csv' },
    ])
    expect(field()).toHaveFocus()
  })

  it('goes from the bar even when main can’t delete the copy', async () => {
    await renderBar({
      overrides: { [CommandName.AttachmentsDiscard]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'busy')) },
    })
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove sales.csv' }))
    await attachedFiles([])
  })
})

describe('sending files', () => {
  it('sends them with the message, in order, and empties the bar', async () => {
    const fake = await renderBar()
    type('Check these against the manifest.')
    await drop([fileOnDisk(SALES), fileOnDisk(POLICY)])
    await attachedFiles(['sales.csv', 'retention policy.pdf'])

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([
      {
        id: 't1',
        text: 'Check these against the manifest.',
        files: [sampleAttachedFile('t1', SALES), sampleAttachedFile('t1', POLICY)],
      },
    ])
    expect(chips()).toEqual([])
    expect(field()).toHaveValue('')
  })

  it('sends a message of files alone', async () => {
    const fake = await renderBar()
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([
      { id: 't1', text: '', files: [sampleAttachedFile('t1', SALES)] },
    ])
  })

  it('queues them with the message while the agent works', async () => {
    const fake = await renderBar({ task: { activity: TaskActivity.Working } })
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    await send()

    expect(requests(fake, CommandName.QueueAdd)).toEqual([
      { taskId: 't1', text: '', files: [sampleAttachedFile('t1', SALES)] },
    ])
  })

  it('refuses them with an answer to the agent’s questions, keeping them in the bar', async () => {
    const fake = await renderBar({ task: { asking: true } })
    type('Yes, that one.')
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    await send()

    expect(requests(fake, CommandName.TasksSend)).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent(ASKING_ATTACHMENTS_REFUSAL)
    expect(chips()).toEqual(['sales.csv'])
  })
})

describe('the draft’s files', () => {
  const sales: AttachedFile = sampleAttachedFile('t1', SALES)
  const policy: AttachedFile = { ...sampleAttachedFile('t1', POLICY), kind: AttachedFileKind.Binary }

  it('come back from the stored draft after a relaunch, as chips', async () => {
    await renderBar({
      drafts: { t1: { text: 'Half a thought', images: [], pastedBlocks: [], files: [sales, policy] } },
    })
    await attachedFiles(['sales.csv', 'retention policy.pdf'])
    expect(field()).toHaveValue('Half a thought')
  })

  it('are stored with the draft, and stay with the task while you look at another', async () => {
    const fake = await renderBar()
    await drop([fileOnDisk(SALES)])
    await attachedFiles(['sales.csv'])

    await act(() => fake.store.getState().selectTask('t2'))
    expect(chips()).toEqual([])
    expect(requests(fake, CommandName.DraftsSet)).toContainEqual({ taskId: 't1', text: '', files: [sales] })

    await act(() => fake.store.getState().selectTask('t1'))
    expect(chips()).toEqual(['sales.csv'])
  })
})

describe('a queued message’s files', () => {
  it('show small in its row, each by its name', async () => {
    const queued = {
      ...sampleQueuedMessage('q1', 't1', 'Here’s the log.'),
      files: [sampleAttachedFile('t1', '/tmp/Desktop/copy-errors.log')],
    }
    await renderBar({ task: { activity: TaskActivity.Working }, queued: [queued] })
    const row = within(screen.getByRole('region', { name: 'Queued messages' })).getByRole('listitem')
    expect(within(row).getByTitle('copy-errors.log')).toHaveTextContent('copy-errors.log')
    expect(row).toHaveTextContent('Here’s the log.')
  })
})

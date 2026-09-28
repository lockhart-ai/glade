// Editing a workspace file in the Files tab: typing, saving (⌘S), the unsaved dot, the prompts before closing a tab,
// and the file changing on disk. The editor is CodeMirror; tests edit it as typing would, through its view.
import { redo, undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventType, type FilesWriteRequest } from '../../shared/bridge'
import {
  FileContentKind,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type FileContent,
  type OpenFiles,
  type ToolCallEvent,
} from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeMain } from '../store/test-bridge'
import { FilesTab } from './FilesTab'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'

const ROOT = sampleWorkspace('w1').rootPath

const LIMITS = '# Rate limits\n\n| /search | 60 |\n'
const THROTTLES = 'class KeyThrottle:\n    rate = 120\n'

function text(value: string): FileContent {
  return { kind: FileContentKind.Text, text: value, truncated: false, size: value.length }
}

const OPEN: OpenFiles = {
  taskId: 't1',
  paths: ['docs/rate-limits.md', 'api/throttles.py'],
  activePath: 'docs/rate-limits.md',
}

function edited(id: string, path: string): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: 0,
    kind: ToolEventKind.ToolCall,
    name: 'Edit',
    input: { file_path: `${ROOT}/${path}` },
    output: 'ok',
    state: ToolCallState.Done,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    progressSummary: null,
  }
}

interface Rendered {
  readonly store: GladeStore
  /** What `files.read` answers with now: change it as the agent changing the file would. */
  readonly files: Record<string, FileContent>
  readonly written: FilesWriteRequest[]
  readonly main: FakeMain
  readonly emit: ReturnType<typeof fakeBridge>['emit']
}

async function renderEditing(openFiles: OpenFiles = OPEN, main: Partial<FakeMain> = {}): Promise<Rendered> {
  const files: Record<string, FileContent> = {
    'docs/rate-limits.md': text(LIMITS),
    'api/throttles.py': text(THROTTLES),
  }
  const written: FilesWriteRequest[] = []
  const fakeMain: FakeMain = {
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ],
    toolEvents: [edited('c1', 'docs/rate-limits.md')],
    openFiles: [openFiles],
    files,
    writtenFiles: written,
    ...main,
  }
  const fake = fakeBridge(fakeMain)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <FilesTab taskId="t1" rootPath={ROOT} focus={null} />
        <UnsavedChangesDialog />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await screen.findByTestId('editor')
  return { store, files, written, main: fakeMain, emit: fake.emit }
}

/** The editor showing. */
function view(): EditorView {
  const dom = screen.getByTestId('editor').querySelector('.cm-editor')
  const found = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
  if (found === null) throw new Error('No editor showing')
  return found
}

/** Types `typed` at `at` in the editor showing, as the keyboard would. */
function type(typed: string, at = 0): void {
  act(() => {
    view().dispatch({ changes: { from: at, insert: typed }, userEvent: 'input.type' })
  })
}

function tabs(): HTMLElement {
  return screen.getByRole('group', { name: 'Open files' })
}

/** The dot in place of a tab's cross, while its file has unsaved edits. */
function unsavedDot(name: string): HTMLElement | null {
  return within(tabs()).queryByRole('button', { name: `Close ${name} (unsaved edits)` })
}

function pressSave(): void {
  fireEvent.keyDown(window, { key: 's', code: 'KeyS', metaKey: true })
}

/** Runs the agent's finished edit of a file: the Files tab reads it again. */
function agentEdits(emit: Rendered['emit'], id: string, path = 'docs/rate-limits.md'): void {
  act(() => {
    emit({ type: EventType.ToolEventAppended, toolEvent: edited(id, path) })
  })
}

describe('editing a file', () => {
  it('marks the tab unsaved while the text differs from the file, and not once undone back to it', async () => {
    await renderEditing()
    expect(unsavedDot('rate-limits.md')).toBeNull()

    type('Draft: ')
    expect(view().state.doc.line(1).text).toBe('Draft: # Rate limits')
    const dot = unsavedDot('rate-limits.md')
    expect(dot).not.toBeNull()
    expect(dot).toHaveAttribute('title', 'Unsaved edits · Close (⌘W)')
    expect(dot?.parentElement).toHaveAttribute('data-unsaved', 'true')

    act(() => {
      undo(view())
    })
    expect(unsavedDot('rate-limits.md')).toBeNull()
    act(() => {
      redo(view())
    })
    expect(unsavedDot('rate-limits.md')).not.toBeNull()
  })

  it('saves the file showing with ⌘S, and the dot goes; with nothing unsaved, ⌘S writes nothing', async () => {
    const { written } = await renderEditing()

    pressSave()
    await act(() => Promise.resolve())
    expect(written).toEqual([])

    type('Draft: ')
    pressSave()

    await waitFor(() => {
      expect(unsavedDot('rate-limits.md')).toBeNull()
    })
    expect(written).toEqual([{ taskId: 't1', path: 'docs/rate-limits.md', text: `Draft: ${LIMITS}` }])
  })

  it('shows a toast when saving fails, keeping the edits unsaved', async () => {
    const { written } = await renderEditing(OPEN, { refuseWrites: 'the disk is full' })

    type('Draft: ')
    pressSave()

    expect(await screen.findByText('Couldn’t save rate-limits.md: the disk is full')).toBeInTheDocument()
    expect(unsavedDot('rate-limits.md')).not.toBeNull()
    expect(view().state.doc.line(1).text).toBe('Draft: # Rate limits')
    expect(written).toEqual([])
  })

  it('keeps the edits, and their undo history, while another file’s tab shows', async () => {
    await renderEditing()
    type('Draft: ')

    fireEvent.click(within(tabs()).getByRole('button', { name: 'throttles.py' }))
    await waitFor(() => {
      expect(view().state.doc.line(1).text).toBe('class KeyThrottle:')
    })
    expect(unsavedDot('rate-limits.md')).not.toBeNull()

    fireEvent.click(within(tabs()).getByRole('button', { name: /rate-limits\.md/, pressed: false }))
    await waitFor(() => {
      expect(view().state.doc.line(1).text).toBe('Draft: # Rate limits')
    })
    act(() => {
      undo(view())
    })
    expect(view().state.doc.line(1).text).toBe('# Rate limits')
  })

  it('previews the edited text of a Markdown file', async () => {
    await renderEditing()
    type('# Limits for clients\n\n')

    fireEvent.click(screen.getByRole('radio', { name: 'Preview' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Limits for clients' })).toBeInTheDocument()
  })

  it('takes the agent’s change quietly while there are no unsaved edits', async () => {
    const { files, emit } = await renderEditing()

    files['docs/rate-limits.md'] = text('# Rate limits\n\n| /search | 30 |\n')
    agentEdits(emit, 'c2')

    await waitFor(() => {
      expect(view().state.doc.line(3).text).toBe('| /search | 30 |')
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(unsavedDot('rate-limits.md')).toBeNull()
  })

  it('says the file changed on disk under unsaved edits; Keep mine keeps them, and saving writes over the disk', async () => {
    const { files, emit, written } = await renderEditing()
    type('Draft: ')

    files['docs/rate-limits.md'] = text('# Rate limits\n\n| /search | 30 |\n')
    agentEdits(emit, 'c2')

    const bar = await screen.findByRole('alert')
    expect(bar).toHaveTextContent('This file changed on disk.')
    expect(view().state.doc.line(1).text).toBe('Draft: # Rate limits')

    fireEvent.click(within(bar).getByRole('button', { name: 'Keep mine' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(unsavedDot('rate-limits.md')).not.toBeNull()

    pressSave()
    await waitFor(() => {
      expect(written).toEqual([{ taskId: 't1', path: 'docs/rate-limits.md', text: `Draft: ${LIMITS}` }])
    })
  })

  it('Reload drops the unsaved edits for the file on disk', async () => {
    const { files, emit } = await renderEditing()
    type('Draft: ')

    files['docs/rate-limits.md'] = text('# Rate limits\n\n| /search | 30 |\n')
    agentEdits(emit, 'c2')
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Reload' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(view().state.doc.toString()).toBe('# Rate limits\n\n| /search | 30 |\n')
    expect(unsavedDot('rate-limits.md')).toBeNull()
  })

  it('shows the file gone once you Reload after it went from disk under your edits', async () => {
    const { files, emit } = await renderEditing()
    type('Draft: ')

    files['docs/rate-limits.md'] = { kind: FileContentKind.Missing }
    agentEdits(emit, 'c2')
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Reload' }))

    expect(await screen.findByText('This file isn’t there any more.')).toBeInTheDocument()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(unsavedDot('rate-limits.md')).toBeNull()
  })

  it('shows the file gone at once when it went with nothing unsaved', async () => {
    const { files, emit } = await renderEditing()

    files['docs/rate-limits.md'] = { kind: FileContentKind.Binary, size: 4096 }
    agentEdits(emit, 'c2')

    expect(await screen.findByText(/This file isn’t text \(4 KB\)/)).toBeInTheDocument()
    expect(screen.queryByTestId('editor')).toBeNull()
  })
})

describe('closing a file with unsaved edits', () => {
  it('asks first: Cancel keeps it, edits and all', async () => {
    const { written } = await renderEditing()
    type('Draft: ')

    fireEvent.click(within(tabs()).getByRole('button', { name: 'Close rate-limits.md (unsaved edits)' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Save your edits to rate-limits.md?')
    expect(dialog).toHaveTextContent('rate-limits.md has unsaved edits. Discard drops them; the file on disk stays')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(unsavedDot('rate-limits.md')).not.toBeNull()
    expect(view().state.doc.line(1).text).toBe('Draft: # Rate limits')
    expect(written).toEqual([])
  })

  it('Discard closes it without saving', async () => {
    const { written } = await renderEditing()
    type('Draft: ')

    fireEvent.click(within(tabs()).getByRole('button', { name: 'Close rate-limits.md (unsaved edits)' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))

    await waitFor(() => {
      expect(within(tabs()).queryByRole('button', { name: /rate-limits\.md/ })).toBeNull()
    })
    expect(written).toEqual([])
  })

  it('Save saves it, then closes it', async () => {
    const { written } = await renderEditing()
    type('Draft: ')

    fireEvent.click(within(tabs()).getByRole('button', { name: 'Close rate-limits.md (unsaved edits)' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(within(tabs()).queryByRole('button', { name: /rate-limits\.md/ })).toBeNull()
    })
    expect(written).toEqual([{ taskId: 't1', path: 'docs/rate-limits.md', text: `Draft: ${LIMITS}` }])
  })

  it('keeps it open, with a toast, when saving fails', async () => {
    await renderEditing(OPEN, { refuseWrites: 'the disk is full' })
    type('Draft: ')

    fireEvent.click(within(tabs()).getByRole('button', { name: 'Close rate-limits.md (unsaved edits)' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Couldn’t save: the disk is full')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(unsavedDot('rate-limits.md')).not.toBeNull()
  })

  it('stops closing all the tabs at the first you cancel', async () => {
    await renderEditing({ ...OPEN, paths: ['api/throttles.py', 'docs/rate-limits.md', 'config/settings.py'] })
    type('Draft: ')

    const tab = within(tabs()).getByRole('button', { name: 'throttles.py' }).parentElement
    fireEvent.contextMenu(tab ?? document.body)
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: /^Close all/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    // The file before it closed; it, and the one after, stay.
    expect(within(tabs()).queryByRole('button', { name: 'throttles.py' })).toBeNull()
    expect(unsavedDot('rate-limits.md')).not.toBeNull()
    expect(within(tabs()).getByRole('button', { name: 'settings.py' })).toBeInTheDocument()
  })
})

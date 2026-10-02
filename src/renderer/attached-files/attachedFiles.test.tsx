import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { AttachedFileKind, type AttachedFile } from '../../shared/attachedFiles'
import { UiStateKey } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { QueuedFileChip } from './FileChip'
import { fileChipDetail, fileIconKind, FileIconKind, opensInFiles } from './fileIcons'
import { MessageFiles } from './MessageFiles'

function file(name: string, kind: AttachedFileKind, size = 48 * 1024): AttachedFile {
  return { name, path: `.glade/attachments/t1/${name}`, size, kind }
}

describe('fileIconKind', () => {
  it('picks the icon by extension, whatever its case', () => {
    expect(fileIconKind(file('sales.CSV', AttachedFileKind.Text))).toBe(FileIconKind.Spreadsheet)
    expect(fileIconKind(file('q3.xlsx', AttachedFileKind.Binary))).toBe(FileIconKind.Spreadsheet)
    expect(fileIconKind(file('policy.pdf', AttachedFileKind.Binary))).toBe(FileIconKind.Pdf)
    expect(fileIconKind(file('chart.png', AttachedFileKind.Image))).toBe(FileIconKind.Image)
    expect(fileIconKind(file('scan.heic', AttachedFileKind.Binary))).toBe(FileIconKind.Image)
    expect(fileIconKind(file('api.py', AttachedFileKind.Text))).toBe(FileIconKind.Code)
    expect(fileIconKind(file('logs.tar.gz', AttachedFileKind.Binary))).toBe(FileIconKind.Archive)
    expect(fileIconKind(file('standup.m4a', AttachedFileKind.Binary))).toBe(FileIconKind.Audio)
    expect(fileIconKind(file('repro.mov', AttachedFileKind.Binary))).toBe(FileIconKind.Video)
    expect(fileIconKind(file('brief.docx', AttachedFileKind.Binary))).toBe(FileIconKind.Document)
    expect(fileIconKind(file('roadmap.key', AttachedFileKind.Binary))).toBe(FileIconKind.Slides)
  })

  it('falls back on what the file holds: text, an image, or any file', () => {
    expect(fileIconKind(file('Makefile', AttachedFileKind.Text))).toBe(FileIconKind.Text)
    expect(fileIconKind(file('.env', AttachedFileKind.Text))).toBe(FileIconKind.Text)
    expect(fileIconKind(file('photo.raw', AttachedFileKind.Image))).toBe(FileIconKind.Image)
    expect(fileIconKind(file('data.parquet', AttachedFileKind.Binary))).toBe(FileIconKind.Other)
  })
})

describe('fileChipDetail', () => {
  it('says the type and size', () => {
    expect(fileChipDetail(file('sales.csv', AttachedFileKind.Text))).toBe('CSV · 48 KB')
    expect(fileChipDetail(file('notes.md', AttachedFileKind.Text, 300))).toBe('Markdown · 300 bytes')
    expect(fileChipDetail(file('Makefile', AttachedFileKind.Text, 2_400_000))).toBe('File · 2.3 MB')
  })
})

describe('opensInFiles', () => {
  it('opens text and images in the Files tab, and reveals anything else', () => {
    expect(opensInFiles(file('a.csv', AttachedFileKind.Text))).toBe(true)
    expect(opensInFiles(file('a.png', AttachedFileKind.Image))).toBe(true)
    expect(opensInFiles(file('a.pdf', AttachedFileKind.Binary))).toBe(false)
  })
})

describe('QueuedFileChip', () => {
  it('shows the file small, by its icon and name, with its name as a tooltip', () => {
    render(<QueuedFileChip file={file('copy-errors.log', AttachedFileKind.Text)} />)
    expect(screen.getByTitle('copy-errors.log')).toHaveTextContent('copy-errors.log')
  })
})

describe('MessageFiles', () => {
  async function renderFiles(files: readonly AttachedFile[], overrides: Partial<FakeHandlers> = {}): Promise<void> {
    const fake = fakeBridge(
      {
        workspaces: [sampleWorkspace('w1')],
        tasks: [sampleTask('t1', 'w1')],
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
        ],
      },
      overrides,
    )
    const store = createGladeStore(fake.bridge)
    render(
      <GladeStoreProvider store={store}>
        <ToastProvider>
          <MessageFiles taskId="t1" files={files} />
        </ToastProvider>
      </GladeStoreProvider>,
    )
    await act(() => store.getState().hydrate())
  }

  it('shows nothing for a message with no files', async () => {
    await renderFiles([])
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull()
  })

  it('says so in a toast when a file can’t be opened or shown, as when its copy is gone', async () => {
    await renderFiles([file('policy.pdf', AttachedFileKind.Binary), file('sales.csv', AttachedFileKind.Text)], {
      [CommandName.FilesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No file at policy.pdf')),
      [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'policy.pdf, PDF · 48 KB' }))
      fireEvent.click(screen.getByRole('button', { name: 'sales.csv, CSV · 48 KB' }))
      await Promise.resolve()
    })

    const toasts = screen.getByRole('region', { name: 'Notifications' })
    expect(toasts).toHaveTextContent('Couldn’t open policy.pdf: No file at policy.pdf')
    expect(toasts).toHaveTextContent('Couldn’t open sales.csv: No task t1')
  })
})

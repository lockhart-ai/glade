import type { BrowserWindow, OpenDialogReturnValue } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { CHOOSE_FOLDER_OPTIONS, chooseFolder, type OpenDialog } from './dialogs'

interface FakeDialog {
  readonly dialog: OpenDialog
  readonly show: ReturnType<typeof vi.fn>
}

function fakeDialog(answer: OpenDialogReturnValue): FakeDialog {
  const show = vi.fn(() => Promise.resolve(answer))
  return { dialog: { showOpenDialog: show }, show }
}

describe('CHOOSE_FOLDER_OPTIONS', () => {
  it('asks for one folder and offers to create a new one', () => {
    expect(CHOOSE_FOLDER_OPTIONS.properties).toEqual(['openDirectory', 'createDirectory'])
  })
})

describe('chooseFolder', () => {
  it('shows the dialog as a sheet on the window and answers with the chosen folder', async () => {
    const { dialog, show } = fakeDialog({ canceled: false, filePaths: ['/code/acme-api'] })
    const window = {} as BrowserWindow

    await expect(chooseFolder(dialog, window)).resolves.toBe('/code/acme-api')
    expect(show).toHaveBeenCalledWith(window, CHOOSE_FOLDER_OPTIONS)
  })

  it('shows a free-standing dialog when there is no window', async () => {
    const { dialog, show } = fakeDialog({ canceled: false, filePaths: ['/code/acme-api'] })

    await expect(chooseFolder(dialog, null)).resolves.toBe('/code/acme-api')
    expect(show).toHaveBeenCalledWith(CHOOSE_FOLDER_OPTIONS)
  })

  it('answers null when the dialog is cancelled or nothing was chosen', async () => {
    await expect(
      chooseFolder(fakeDialog({ canceled: true, filePaths: ['/code/acme-api'] }).dialog, null),
    ).resolves.toBeNull()
    await expect(chooseFolder(fakeDialog({ canceled: false, filePaths: [] }).dialog, null)).resolves.toBeNull()
  })
})

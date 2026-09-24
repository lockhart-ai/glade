import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'

/** The part of Electron's `dialog` the folder chooser uses, so tests can stand in a fake. */
export interface OpenDialog {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

/** Asks for a folder. The dialog's New Folder button creates one to choose (`createDirectory`, macOS). */
export const CHOOSE_FOLDER_OPTIONS: OpenDialogOptions = {
  title: 'Choose a workspace folder',
  buttonLabel: 'Choose',
  properties: ['openDirectory', 'createDirectory'],
}

/**
 * Shows the native open-folder dialog, as a sheet on `window` when there is one.
 *
 * @returns The chosen folder's path, or null when the dialog was cancelled.
 */
export async function chooseFolder(dialog: OpenDialog, window: BrowserWindow | null): Promise<string | null> {
  const { canceled, filePaths } = await (window === null
    ? dialog.showOpenDialog(CHOOSE_FOLDER_OPTIONS)
    : dialog.showOpenDialog(window, CHOOSE_FOLDER_OPTIONS))
  return canceled ? null : (filePaths[0] ?? null)
}

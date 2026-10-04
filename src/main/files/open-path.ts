/** How Glade has macOS open a path: on its own, with nothing else of the app's, so the test modes can stand in for it. */

/** How a path is opened. */
export enum OpenWith {
  /** The app macOS opens its kind of file with: Electron's `shell.openPath`. A folder opens in Finder. */
  Default = 'default',
  /** The default text editor, whatever kind of file it is (`open -t`): the file is shown as text, never run. */
  TextEditor = 'text_editor',
}

/**
 * Opens a path, in the app macOS opens its kind of file with unless told otherwise (`OpenWith`). Answers with an error
 * message, or `''`, as Electron's `shell.openPath` does.
 */
export type OpenPath = (path: string, how?: OpenWith) => Promise<string>

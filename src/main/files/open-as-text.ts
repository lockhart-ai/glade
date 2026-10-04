/**
 * Opening a file as text (#514): macOS's `open -t`, which hands the file to the default text editor whatever kind of
 * file it is. Open in editor uses it (`./files`), so a file the agent wrote is shown, never run: opened the ordinary
 * way, a Unix executable or a `.command` file runs in Terminal, outside any sandbox.
 */
import { execFile } from 'node:child_process'
import type { OpenPath } from './open-path'

/** macOS's `open`, by its full path: nothing on the PATH can stand in for it. */
export const OPEN_COMMAND = '/usr/bin/open'

/** Runs a program with arguments and no shell, and says how it ended: Node's `execFile`, as far as it's used here. */
export type RunFile = (
  file: string,
  args: readonly string[],
  done: (error: Error | null, stdout: string, stderr: string) => void,
) => void

/** What `open` prints when it fails, or the error itself, in a line. */
function failureOf(error: Error, stderr: string): string {
  const said = stderr.trim()
  return said === '' ? error.message : said
}

/**
 * What opens a file in the default text editor: `open -t <path>`. Answers with an error message, or `''`, as
 * `shell.openPath` does. The path is always absolute, so it can't be taken for one of `open`'s options.
 */
export function createOpenAsText(run: RunFile = execFile): (path: string) => ReturnType<OpenPath> {
  return (path) =>
    new Promise((resolve) => {
      run(OPEN_COMMAND, ['-t', path], (error, _stdout, stderr) => {
        resolve(error === null ? '' : failureOf(error, stderr))
      })
    })
}

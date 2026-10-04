// Opening a file as text (#514): `open -t`, so a file the agent wrote is shown in the text editor, never run.
import { describe, expect, it, vi } from 'vitest'
import { createOpenAsText, OPEN_COMMAND, type RunFile } from './open-as-text'

/** Node's `execFile`, stood in for: a test never starts a real `open`. */
const execFile = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile, default: { execFile } }))

/** A `run` that records what it was asked to run, and ends as told. */
function runner(error: Error | null = null, stderr = ''): { run: RunFile; calls: [string, readonly string[]][] } {
  const calls: [string, readonly string[]][] = []
  return {
    calls,
    run: (file, args, done) => {
      calls.push([file, args])
      done(error, '', stderr)
    },
  }
}

describe('createOpenAsText', () => {
  it('opens the file with macOS’s own `open`, in the text editor, and nothing else', async () => {
    const { run, calls } = runner()

    await expect(createOpenAsText(run)('/Users/me/src/acme-api/notes.command')).resolves.toBe('')

    expect(calls).toEqual([[OPEN_COMMAND, ['-t', '/Users/me/src/acme-api/notes.command']]])
    expect(OPEN_COMMAND).toBe('/usr/bin/open')
  })

  it('passes a path with spaces, quotes or a dollar sign as one argument: no shell reads it', async () => {
    const { run, calls } = runner()
    const path = '/Users/me/My Projects/$(rm -rf ~)/it\'s "fine".txt'

    await createOpenAsText(run)(path)

    expect(calls).toEqual([[OPEN_COMMAND, ['-t', path]]])
  })

  it('answers with what `open` said when it fails, or the error itself', async () => {
    const failed = new Error('Command failed: /usr/bin/open -t /Users/me/gone.md')
    const said = runner(failed, 'The file /Users/me/gone.md does not exist.\n')
    await expect(createOpenAsText(said.run)('/Users/me/gone.md')).resolves.toBe(
      'The file /Users/me/gone.md does not exist.',
    )

    const silent = runner(failed)
    await expect(createOpenAsText(silent.run)('/Users/me/gone.md')).resolves.toBe(failed.message)
  })

  it('runs Node’s own `execFile` unless given another: never a shell', async () => {
    execFile.mockImplementation((_file: string, _args: readonly string[], done: (error: Error | null) => void) => {
      done(null)
    })

    await expect(createOpenAsText()('/Users/me/src/acme-api/README.md')).resolves.toBe('')

    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/open',
      ['-t', '/Users/me/src/acme-api/README.md'],
      expect.any(Function),
    )
  })
})

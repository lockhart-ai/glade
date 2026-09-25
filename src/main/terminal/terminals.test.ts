import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { listTerminalTabs } from '../db/repositories/terminal-tabs'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { createFakeSpawner, FAKE_SHELL, type FakePty, type FakeSpawner } from './fake-pty'
import {
  createTerminals,
  PROCESS_POLL_MS,
  RESTORED_DIVIDER,
  SAVE_DELAY_MS,
  SCROLLBACK_LIMIT,
  trimScrollback,
  type Terminals,
} from './terminals'

const SIZE = { cols: 80, rows: 24 }

let database: TestDatabase
let root: string
let emit: Mock<(event: GladeEvent) => void>
let spawner: FakeSpawner
let terminals: Terminals

/** The terminal tabs as they'd be after a relaunch: loaded from the database again. */
function relaunch(): Terminals {
  terminals.shutdown()
  spawner = createFakeSpawner()
  terminals = createTerminals({ db: database.db, emit, spawn: spawner.spawn, shell: FAKE_SHELL, fallbackCwd: root })
  return terminals
}

/** The shell a tab started, the nth to start. */
function shell(index = 0): FakePty {
  const pty = spawner.spawned[index]
  if (pty === undefined) throw new Error(`No shell ${String(index)}`)
  return pty
}

/** The events of one type emitted so far. */
function emitted<T extends GladeEvent['type']>(type: T): Extract<GladeEvent, { type: T }>[] {
  return emit.mock.calls
    .map(([event]) => event)
    .filter((event): event is Extract<GladeEvent, { type: T }> => event.type === type)
}

beforeEach(() => {
  vi.useFakeTimers()
  database = openTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'glade-terminals-'))
  emit = vi.fn()
  spawner = createFakeSpawner()
  terminals = createTerminals({ db: database.db, emit, spawn: spawner.spawn, shell: FAKE_SHELL, fallbackCwd: tmpdir() })
})

afterEach(() => {
  terminals.shutdown()
  database.close()
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('trimScrollback', () => {
  it('keeps output within the limit as it is', () => {
    expect(trimScrollback('a\r\nb\r\n', 10)).toBe('a\r\nb\r\n')
  })

  it('keeps the last of longer output, from the start of a line', () => {
    expect(trimScrollback('first\r\nsecond\r\nthird\r\n', 12)).toBe('third\r\n')
  })

  it('keeps the last characters of a line longer than the limit', () => {
    expect(trimScrollback('abcdefghij', 4)).toBe('ghij')
  })
})

describe('the terminal tabs', () => {
  it('adds a tab whose shell starts in its folder, at the terminal’s size, when a window first shows it', () => {
    const tab = terminals.create(root)

    expect(tab).toEqual({ id: tab.id, name: null, process: 'zsh', running: false, cwd: root })
    expect(emitted(EventType.TerminalTabsChanged)).toEqual([{ type: EventType.TerminalTabsChanged, tabs: [tab] }])
    expect(spawner.spawned).toEqual([])

    expect(terminals.attach(tab.id, SIZE)).toEqual({ output: '', end: 0 })
    expect(shell().options).toEqual({ file: '/bin/zsh', args: ['-l'], cwd: root, size: SIZE, env: FAKE_SHELL.env })

    terminals.attach(tab.id, { cols: 100, rows: 30 })
    expect(spawner.spawned).toHaveLength(1)
  })

  it('starts a shell with no workspace, or whose folder has gone, in the fallback folder', () => {
    const homeless = terminals.create(null)
    const gone = terminals.create(join(root, 'gone'))
    expect(homeless.cwd).toBe(tmpdir())

    terminals.attach(homeless.id, SIZE)
    terminals.attach(gone.id, SIZE)

    expect(shell(0).options.cwd).toBe(tmpdir())
    expect(shell(1).options.cwd).toBe(tmpdir())
    expect(terminals.list()[1]?.cwd).toBe(join(root, 'gone'))
  })

  it('broadcasts the shell’s output, counting where each piece starts', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)

    shell().output('~/code/api $ ')
    shell().output('ls\r\n')

    expect(emitted(EventType.TerminalOutput)).toEqual([
      { type: EventType.TerminalOutput, tabId: id, offset: 0, data: '~/code/api $ ' },
      { type: EventType.TerminalOutput, tabId: id, offset: 13, data: 'ls\r\n' },
    ])
    expect(terminals.attach(id, SIZE)).toEqual({ output: '~/code/api $ ls\r\n', end: 17 })
  })

  it('types into the shell once it has shown its prompt, keeping what was typed before in order', () => {
    const { id } = terminals.create(root)
    terminals.write(id, 'npm ')
    terminals.attach(id, SIZE)
    terminals.write(id, 'test')
    expect(shell().written).toEqual([])

    shell().output('$ ')
    terminals.write(id, '\r')

    expect(shell().written).toEqual(['npm ', 'test', '\r'])
  })

  it('resizes the shell’s terminal, and interrupts what runs in it', () => {
    const { id } = terminals.create(root)
    terminals.resize(id, { cols: 10, rows: 5 })
    terminals.interrupt(id)
    terminals.attach(id, SIZE)

    terminals.resize(id, { cols: 120, rows: 40 })
    terminals.interrupt(id)

    expect(shell().size).toEqual({ cols: 120, rows: 40 })
    expect(shell().interrupts).toBe(1)
  })

  it('names a tab, and duplicates it after itself with its name and folder', () => {
    const first = terminals.create(root)
    const last = terminals.create(root)
    terminals.rename(first.id, 'server')

    const copy = terminals.duplicate(first.id)

    expect(copy).toMatchObject({ name: 'server', cwd: root, process: 'zsh' })
    expect(terminals.list().map(({ id }) => id)).toEqual([first.id, copy.id, last.id])
    expect(listTerminalTabs(database.db).map(({ id, name }) => [id, name])).toEqual([
      [first.id, 'server'],
      [copy.id, 'server'],
      [last.id, null],
    ])
    expect(emitted(EventType.TerminalTabsChanged).at(-1)?.tabs).toEqual(terminals.list())
  })

  it('closes a tab, ending its shell', () => {
    const { id } = terminals.create(root)
    const other = terminals.create(root)
    terminals.attach(id, SIZE)

    terminals.close(id)

    expect(shell().killed).toBe(true)
    expect(terminals.list().map((tab) => tab.id)).toEqual([other.id])
    expect(listTerminalTabs(database.db).map((tab) => tab.id)).toEqual([other.id])
    terminals.close(other.id)
    expect(terminals.list()).toEqual([])
  })

  it('closes a tab whose shell exits', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)

    shell().exit()

    expect(terminals.list()).toEqual([])
    expect(emitted(EventType.TerminalTabsChanged).at(-1)?.tabs).toEqual([])
  })

  it('refuses a tab that isn’t there', () => {
    for (const act of [
      () => terminals.attach('gone', SIZE),
      () => {
        terminals.write('gone', 'ls')
      },
      () => {
        terminals.close('gone')
      },
    ]) {
      expect(act).toThrow(expect.objectContaining({ code: BridgeErrorCode.NotFound }))
    }
  })
})

describe('what’s running in a tab', () => {
  it('follows the foreground process: its name, and a running dot while it isn’t the shell', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)
    emit.mockClear()

    vi.advanceTimersByTime(PROCESS_POLL_MS)
    expect(emitted(EventType.TerminalTabsChanged)).toEqual([])

    shell().process = 'python3'
    vi.advanceTimersByTime(PROCESS_POLL_MS)
    expect(emitted(EventType.TerminalTabsChanged).at(-1)?.tabs).toEqual([
      { id, name: null, process: 'python3', running: true, cwd: root },
    ])

    shell().process = 'zsh'
    vi.advanceTimersByTime(PROCESS_POLL_MS)
    expect(terminals.list()[0]).toMatchObject({ process: 'zsh', running: false })
    expect(emitted(EventType.TerminalTabsChanged)).toHaveLength(2)
  })

  it('stops checking once no shell runs', () => {
    const { id } = terminals.create(root)
    const idle = terminals.create(root)
    terminals.attach(id, SIZE)
    terminals.close(idle.id)
    expect(vi.getTimerCount()).toBe(1)

    terminals.close(id)

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('across a relaunch', () => {
  it('keeps the tabs, in order, with their names, folders and recent output over a divider and a new shell', () => {
    const first = terminals.create(root)
    const second = terminals.create(root)
    terminals.rename(second.id, 'server')
    terminals.attach(first.id, SIZE)
    shell().output('$ echo hello\r\nhello\r\n$ ')

    relaunch()

    const history = `$ echo hello\r\nhello\r\n$ ${RESTORED_DIVIDER}`
    expect(terminals.list()).toEqual([
      { id: first.id, name: null, process: 'zsh', running: false, cwd: root },
      { id: second.id, name: 'server', process: 'zsh', running: false, cwd: root },
    ])
    expect(terminals.attach(first.id, SIZE)).toEqual({ output: history, end: history.length })
    expect(terminals.attach(second.id, SIZE)).toEqual({ output: '', end: 0 })
    shell(0).output('$ ')
    expect(emitted(EventType.TerminalOutput).at(-1)).toMatchObject({ offset: history.length, data: '$ ' })

    // The divider stays with the output it follows, so the next relaunch shows both.
    relaunch()
    expect(terminals.attach(first.id, SIZE).output).toBe(`${history}$ ${RESTORED_DIVIDER}`)
  })

  it('saves output a moment after it arrives, not on every piece', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)
    shell().output('a')
    shell().output('b')
    expect(listTerminalTabs(database.db)[0]?.scrollback).toBe('')

    vi.advanceTimersByTime(SAVE_DELAY_MS)

    expect(listTerminalTabs(database.db)[0]?.scrollback).toBe('ab')
  })

  it('keeps only the recent output', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)
    const line = `${'x'.repeat(99)}\n`
    for (let index = 0; index < (SCROLLBACK_LIMIT / line.length) * 2; index += 1) shell().output(line)

    terminals.shutdown()

    const saved = listTerminalTabs(database.db)[0]?.scrollback ?? ''
    expect(saved.length).toBeLessThanOrEqual(SCROLLBACK_LIMIT)
    expect(saved.length).toBeGreaterThan(SCROLLBACK_LIMIT - line.length)
    expect(saved.startsWith('x')).toBe(true)
  })

  it('forgets a cleared tab’s output, and tells the windows to clear it', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)
    shell().output('secret\r\n')

    terminals.clear(id)

    expect(emitted(EventType.TerminalCleared)).toEqual([{ type: EventType.TerminalCleared, tabId: id }])
    expect(terminals.attach(id, SIZE)).toEqual({ output: '', end: 8 })
    relaunch()
    expect(terminals.attach(id, SIZE).output).toBe('')
  })

  it('ends the shells when the app quits, keeping their tabs', () => {
    const { id } = terminals.create(root)
    terminals.attach(id, SIZE)

    terminals.shutdown()

    expect(shell().killed).toBe(true)
    expect(listTerminalTabs(database.db).map((tab) => tab.id)).toEqual([id])
    expect(vi.getTimerCount()).toBe(0)
  })
})

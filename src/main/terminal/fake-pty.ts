// A stand-in for node-pty in unit tests, which must never start a real shell: a pseudo-terminal a test drives by hand.
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalOptions } from '../bridge'
import type { Pty, PtyExit, PtyOptions, SpawnPty, TerminalSize } from './pty'
import type { TerminalShell } from './shell'

/** SIGHUP's number: what a killed shell exits with. */
const SIGHUP = 1

/** A pseudo-terminal that outputs and exits when its test says, and records what it's asked to do. */
export class FakePty implements Pty {
  /** The foreground process's name: the shell's, until a test sets another. */
  process: string
  size: TerminalSize
  /** What was typed into it, in order. */
  readonly written: string[] = []
  /** How many times it was interrupted. */
  interrupts = 0
  killed = false
  private readonly dataListeners: ((data: string) => void)[] = []
  private readonly exitListeners: ((exit: PtyExit) => void)[] = []

  constructor(readonly options: PtyOptions) {
    this.process = basename(options.file)
    this.size = options.size
  }

  /** Outputs `data`, as the shell would. */
  output(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  /** Ends the shell, as `exit` would: with code 0 by default. */
  exit(exit: PtyExit = { exitCode: 0, signal: null }): void {
    for (const listener of this.exitListeners) listener(exit)
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListeners.push(listener)
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(size: TerminalSize): void {
    this.size = size
  }

  interrupt(): void {
    this.interrupts += 1
  }

  /** Ends the shell, which then exits, as a real one does on SIGHUP. */
  kill(): void {
    this.killed = true
    this.exit({ exitCode: 0, signal: SIGHUP })
  }
}

/** A `SpawnPty` that starts fake pseudo-terminals, and the ones it started, oldest first. */
export interface FakeSpawner {
  readonly spawn: SpawnPty
  readonly spawned: FakePty[]
}

export function createFakeSpawner(): FakeSpawner {
  const spawned: FakePty[] = []
  return {
    spawned,
    spawn: (options) => {
      const pty = new FakePty(options)
      spawned.push(pty)
      return pty
    },
  }
}

/** The shell the fake terminals say they run. */
export const FAKE_SHELL: TerminalShell = { file: '/bin/zsh', args: ['-l'], env: { TERM: 'xterm-256color' } }

/** Terminal options for a bridge in a unit test: fake pseudo-terminals, falling back to the temp folder. */
export function fakeTerminalOptions(spawner: FakeSpawner = createFakeSpawner()): TerminalOptions {
  return { spawn: spawner.spawn, shell: FAKE_SHELL, fallbackCwd: tmpdir() }
}

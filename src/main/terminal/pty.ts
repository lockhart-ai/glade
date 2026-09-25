/**
 * The pseudo-terminal a terminal tab's shell runs in, behind a small interface: the app runs it on node-pty
 * (`./node-pty`), and unit tests on a fake (`./fake-pty`), since a unit test must never start a real shell.
 */

/** A shell running in a pseudo-terminal. */
export interface Pty {
  /**
   * The name of the process in the foreground of the terminal (node-pty's `process`): the shell's while it waits at its
   * prompt, or the program's it's running.
   */
  readonly process: string
  /** Calls `listener` with everything the terminal outputs. */
  onData(listener: (data: string) => void): void
  /** Calls `listener` once the shell has exited. */
  onExit(listener: () => void): void
  /** Types into the terminal. */
  write(data: string): void
  resize(size: TerminalSize): void
  /** Sends SIGINT to the terminal's foreground process group, as ⌃C does. */
  interrupt(): void
  /** Ends the shell, as closing a terminal window does (SIGHUP). */
  kill(): void
}

/** A terminal's size, in character cells. */
export interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

/** What to start in a pseudo-terminal, and where. */
export interface PtyOptions {
  /** The program: the shell. */
  readonly file: string
  readonly args: readonly string[]
  /** The folder it starts in: an existing directory. */
  readonly cwd: string
  readonly size: TerminalSize
  readonly env: Readonly<Record<string, string>>
}

/** Starts a program in a new pseudo-terminal. Throws when it can't be started. */
export type SpawnPty = (options: PtyOptions) => Pty

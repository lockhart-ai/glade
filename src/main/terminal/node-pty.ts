import { execFile } from 'node:child_process'
import { spawn } from 'node-pty'
import { foregroundGroup } from './foreground'
import type { SpawnPty } from './pty'

/**
 * Sends SIGINT to the foreground process group of the terminal a shell controls: what ⌃C does, even when the program
 * has put the terminal in raw mode, where a typed ⌃C is just a character. `ps` tells us the group (`tpgid`).
 */
function interruptForeground(shellPid: number): void {
  execFile('ps', ['-o', 'tpgid=', '-p', String(shellPid)], (error, stdout) => {
    const group = error === null ? foregroundGroup(stdout) : null
    if (group === null) return
    try {
      process.kill(-group, 'SIGINT')
    } catch {
      // The group ended in the meantime: nothing left to interrupt.
    }
  })
}

/** Starts a program in a real pseudo-terminal, with node-pty. */
export const spawnNodePty: SpawnPty = ({ file, args, cwd, size, env }) => {
  const pty = spawn(file, [...args], { name: 'xterm-256color', cwd, cols: size.cols, rows: size.rows, env: { ...env } })
  return {
    get process() {
      // node-pty types it as a string, but it's undefined when it can't find the foreground process group's leader: the
      // program there has just exited.
      const name: unknown = Reflect.get(pty, 'process')
      return typeof name === 'string' ? name : null
    },
    onData: (listener) => {
      pty.onData(listener)
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode, signal }) => {
        listener({ exitCode, signal: signal === undefined || signal === 0 ? null : signal })
      })
    },
    write: (data) => {
      pty.write(data)
    },
    resize: ({ cols, rows }) => {
      pty.resize(cols, rows)
    },
    interrupt: () => {
      interruptForeground(pty.pid)
    },
    kill: () => {
      pty.kill('SIGHUP')
    },
  }
}

import { describe, expect, it } from 'vitest'
import { LogLevel } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { STDERR_DROPPED, STDERR_LIMITED, STDERR_LIMITS, STDERR_LINE, stderrLogger } from './stderr-log'

/** A logger on a memory log, with a clock the test moves. */
function logging(limits = STDERR_LIMITS) {
  const log = createMemoryLog()
  let time = 1_000
  const write = stderrLogger(log.logger.with({ taskId: 'task-1' }), limits, () => time)
  return {
    log,
    write,
    advance: (ms: number) => {
      time += ms
    },
    lines: () => log.withMessage(STDERR_LINE).map((record) => record.fields.line),
  }
}

describe('stderrLogger', () => {
  it('logs each line of what the process prints as a warning for its task, skipping blank ones', () => {
    const { log, write, lines } = logging()
    write('Error: spawn /bin/zsh ENOENT\n\n   \r\nat startup (cli.js:12)\r\n')

    expect(lines()).toEqual(['Error: spawn /bin/zsh ENOENT', 'at startup (cli.js:12)'])
    expect(log.records.every((record) => record.level === LogLevel.Warn)).toBe(true)
    expect(log.records.every((record) => record.fields.taskId === 'task-1')).toBe(true)
  })

  it('cuts a long line short, saying how much more there was', () => {
    const { write, lines } = logging()
    write('x'.repeat(STDERR_LIMITS.maxLineLength + 250))

    expect(lines()).toEqual([`${'x'.repeat(STDERR_LIMITS.maxLineLength)}… (250 more characters)`])
  })

  it('logs only so many lines in a window, however many come, then counts the rest once lines get through again', () => {
    const { log, write, advance, lines } = logging()
    // A flood: ten thousand lines, in one chunk and then one at a time.
    write(Array.from({ length: 5_000 }, (_, i) => `noise ${String(i)}`).join('\n'))
    for (let i = 5_000; i < 10_000; i++) write(`noise ${String(i)}\n`)

    expect(lines()).toHaveLength(STDERR_LIMITS.maxLines)
    expect(lines().at(-1)).toBe(`noise ${String(STDERR_LIMITS.maxLines - 1)}`)
    expect(log.withMessage(STDERR_LIMITED)).toHaveLength(1)
    expect(log.withMessage(STDERR_LIMITED)[0]?.fields).toMatchObject({ maxLines: 20, windowMs: 10_000 })
    expect(log.records.length).toBe(STDERR_LIMITS.maxLines + 1)

    // Still within the window: still counted.
    advance(STDERR_LIMITS.windowMs - 1)
    write('still noise')
    expect(lines()).toHaveLength(STDERR_LIMITS.maxLines)

    advance(1)
    write('Error: the session ended')
    expect(log.withMessage(STDERR_DROPPED).map((record) => record.fields)).toEqual([
      { taskId: 'task-1', dropped: 10_000 - STDERR_LIMITS.maxLines + 1 },
    ])
    expect(lines().at(-1)).toBe('Error: the session ended')
  })

  it('says nothing was dropped when nothing was', () => {
    const { log, write, advance } = logging({ maxLines: 2, windowMs: 100, maxLineLength: 50 })
    write('one\ntwo')
    advance(100)
    write('three')

    expect(log.withMessage(STDERR_DROPPED)).toEqual([])
    expect(log.withMessage(STDERR_LINE)).toHaveLength(3)
  })
})

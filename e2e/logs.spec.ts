/**
 * The log (`docs/logs.md`): a scripted task, followed from its first message to marked done through the log file alone,
 * and the window's errors reaching it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'
import { invoke } from './task-view'

/** One line of the log. */
interface LogLine {
  readonly time: string
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly scope: string
  readonly taskId?: string
  readonly msg: string
  readonly [field: string]: unknown
}

/** The log file's lines, each parsed: every one must be a JSON object. */
function readLog({ logFile }: Glade): LogLine[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogLine)
}

/** A line as `scope msg`, and a field or two that says which. */
function step(line: LogLine): string {
  const detail = [line.command, line.name, line.role, line.type, line.to]
    .filter((value) => typeof value === 'string')
    .join(' ')
  return detail === '' ? `${line.scope} ${line.msg}` : `${line.scope} ${line.msg} ${detail}`
}

/** Whether `steps` has each of `expected` in order, with anything in between. */
function inOrder(steps: readonly string[], expected: readonly string[]): string[] {
  let from = 0
  const missing: string[] = []
  for (const wanted of expected) {
    const found = steps.indexOf(wanted, from)
    if (found === -1) missing.push(wanted)
    else from = found + 1
  }
  return missing
}

const MESSAGE = `The date test is flaky. Can you fix it? ${'It fails in some timezones but not others. '.repeat(15)}`

test('logs: a scripted task can be followed through the log from its first message to marked done', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(MESSAGE)
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await taskHeader(window).markDone.click()
  await expect(taskHeader(window).stateDot).toHaveAccessibleName(/^Done · /)
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  const taskId = tasks[0]?.id ?? ''

  // The whole task, in order, from the lines that carry its id.
  const expected = [
    'ipc command tasks.create',
    'agent session starting',
    'agent scripted agent starting',
    'chat message appended user',
    'runner turn started',
    'agent sdk message system',
    'agent session id saved',
    'task task title changed Fix the flaky date test',
    'tools tool call started Read',
    'tools tool call finished Read',
    'tools tool call started Agent',
    'tools tool call started Grep',
    'tools tool call finished Agent',
    'tools tool call started Edit',
    'agent sdk message result',
    'runner turn result',
    'chat message appended agent',
    'runner turn ended',
    'task task activity changed waiting',
    'task task state changed done',
    'ipc command tasks.markDone',
  ]
  await expect
    .poll(() =>
      inOrder(
        readLog(glade)
          .filter((line) => line.taskId === taskId)
          .map(step),
        expected,
      ),
    )
    .toEqual([])

  const log = readLog(glade)
  for (const line of log) {
    expect(Number.isNaN(Date.parse(line.time))).toBe(false)
    expect(['debug', 'info', 'warn', 'error']).toContain(line.level)
    expect(line.scope).not.toBe('')
  }
  // The app starting, on the scripted agent, logging to the test's own folder.
  expect(log[0]).toMatchObject({ scope: 'app', msg: 'app starting', testMode: 'e2e', agentBackend: 'scripted' })
  // A subagent's tool calls carry the call that started it.
  expect(
    log.find((line) => line.msg === 'tool call started' && line.name === 'Grep' && line.parentToolUseId !== null),
  ).toBeDefined()
  // Message text is at debug level, cut short.
  const text = log.find((line) => line.msg === 'message text' && line.role === 'user')
  expect(text).toMatchObject({ level: 'debug', taskId })
  expect(String(text?.text)).toMatch(/^The date test is flaky\. .*… \(\d+ more characters\)$/)
  expect(String(text?.text).length).toBeLessThan(MESSAGE.length)
  // Nothing in the task went wrong.
  expect(log.filter((line) => line.taskId === taskId && line.level === 'error')).toEqual([])
})

test("logs: the window's uncaught errors and unhandled rejections reach the main log", async ({ launch }) => {
  const glade = await launch()

  await glade.window.evaluate(() => {
    setTimeout(() => {
      throw new Error('Sample renderer failure')
    })
    void Promise.reject(new Error('Sample renderer rejection'))
  })

  await expect
    .poll(() =>
      readLog(glade)
        .filter((line) => line.scope === 'renderer')
        .map(({ level, kind, message }) => ({ level, kind, message }))
        .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
    )
    .toEqual([
      { level: 'error', kind: 'error', message: 'Error: Sample renderer failure' },
      { level: 'error', kind: 'unhandled_rejection', message: 'Error: Sample renderer rejection' },
    ])
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { MessageRole, MessageSource, TaskState } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import type { AgentRunner } from '../agent/runner'
import { appendMessage, listMessages } from '../db/repositories/messages'
import { appendQueuedMessage } from '../db/repositories/queued-messages'
import { createWorkspace } from '../db/repositories/workspaces'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { updateTask } from '../db/repositories/tasks'
import {
  countTaskMessagesFrom,
  refusedTaskMessage,
  sendTaskMessage,
  TASK_MESSAGE_MAX,
  TASK_MESSAGES_PER_HOUR,
  TaskMessageOutcomeKind,
  taskMessagesExceeded,
  senderTaskLine,
  type TaskMessageOutcome,
} from './task-messages'

let test: TestDatabase
let sender: { id: string }
let receiver: { id: string }

/** A runner that takes every send, as an idle task's agent does. */
function idleRunner(): Pick<AgentRunner, 'send' | 'queue'> {
  return {
    send: vi.fn(
      (_taskId: string, text: string, _images: unknown, _blocks: unknown, _files: unknown, source: MessageSource) => ({
        id: 'm',
        taskId: 't',
        role: MessageRole.User,
        body: text,
        turn: 1,
        createdAt: 0,
        summary: null,
        images: [],
        pastedBlocks: [],
        files: [],
        source,
      }),
    ),
    queue: vi.fn(),
  }
}

/** A runner that is busy, so the message queues instead of starting a turn. */
function busyRunner(): Pick<AgentRunner, 'send' | 'queue'> {
  return {
    send: vi.fn(() => {
      throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; queue the message instead')
    }),
    queue: vi.fn(
      (_taskId: string, text: string, _images: unknown, _blocks: unknown, _files: unknown, source: MessageSource) => ({
        id: 'q',
        taskId: 't',
        body: text,
        createdAt: 0,
        images: [],
        pastedBlocks: [],
        files: [],
        source,
      }),
    ),
  }
}

beforeEach(() => {
  test = openTestDatabase()
  const acme = sampleWorkspace(test.db)
  sender = sampleTask(test.db, acme.id)
  receiver = sampleTask(test.db, acme.id)
  test.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Fix the flaky login test', receiver.id)
  test.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Port the chat cases', sender.id)
})

afterEach(() => {
  test.close()
})

const send = (runner: Pick<AgentRunner, 'send' | 'queue'>, to: string, message = 'The login race is fixed.') =>
  sendTaskMessage({ db: test.db, runner }, sender.id, { to, message })

/** The reason a call was refused, failing the test if the message went through instead. */
function refusedReason(outcome: TaskMessageOutcome): string {
  if (outcome.kind !== TaskMessageOutcomeKind.Refused) throw new Error('the message went through')
  return outcome.reason
}

/** Fills the receiver's hour with `count` messages from the sender, delivered or queued. */
function fillTheHour(count: number, queued: boolean): void {
  const now = Date.now()
  for (let index = 0; index < count; index += 1) {
    const body = `${queued ? 'Queued' : 'Message'} ${String(index)}.`
    if (queued) {
      appendQueuedMessage(
        test.db,
        {
          taskId: receiver.id,
          body,
          source: MessageSource.Task,
          senderTaskId: sender.id,
        },
        now - index - 1,
      )
    } else {
      appendMessage(
        test.db,
        {
          taskId: receiver.id,
          role: MessageRole.User,
          body,
          turn: 1,
          source: MessageSource.Task,
          senderTaskId: sender.id,
        },
        now - index - 1,
      )
    }
  }
}

describe('taskMessagesExceeded', () => {
  it('trips at the limit and past it, never under', () => {
    expect(taskMessagesExceeded(0)).toBe(false)
    expect(taskMessagesExceeded(TASK_MESSAGES_PER_HOUR - 1)).toBe(false)
    expect(taskMessagesExceeded(TASK_MESSAGES_PER_HOUR)).toBe(true)
    expect(taskMessagesExceeded(TASK_MESSAGES_PER_HOUR + 3)).toBe(true)
  })
})

describe('countTaskMessagesFrom', () => {
  it('counts the messages one task has sent another, delivered or queued, within the window', () => {
    const now = Date.now()
    appendMessage(
      test.db,
      {
        taskId: receiver.id,
        role: MessageRole.User,
        body: 'One.',
        turn: 1,
        source: MessageSource.Task,
        senderTaskId: sender.id,
      },
      now - 1000,
    )
    appendMessage(
      test.db,
      {
        taskId: receiver.id,
        role: MessageRole.User,
        body: "Another task's message.",
        turn: 1,
        source: MessageSource.Task,
        senderTaskId: 'someone-else',
      },
      now - 1000,
    )
    appendMessage(
      test.db,
      { taskId: receiver.id, role: MessageRole.User, body: 'Your own words.', turn: 1, source: null },
      now - 1000,
    )
    appendQueuedMessage(
      test.db,
      { taskId: receiver.id, body: 'Queued.', source: MessageSource.Task, senderTaskId: sender.id },
      now - 2000,
    )

    expect(countTaskMessagesFrom(test.db, receiver.id, sender.id, now - 60_000)).toBe(2)
    // Outside the window nothing counts.
    expect(countTaskMessagesFrom(test.db, receiver.id, sender.id, now)).toBe(0)
  })
})

describe('sendTaskMessage', () => {
  it('sends to another Active task in the same workspace, carrying the sender', () => {
    const runner = idleRunner()

    const outcome = send(runner, receiver.id)

    expect(outcome).toEqual({ kind: TaskMessageOutcomeKind.Sent, delivery: 'sent' })
    expect(runner.send).toHaveBeenCalledWith(
      receiver.id,
      'The login race is fixed.',
      [],
      [],
      [],
      MessageSource.Task,
      sender.id,
    )
  })

  it('is refused for the calling task itself', () => {
    expect(refusedReason(send(idleRunner(), sender.id))).toBe(
      "That's this task: you can't message yourself. Call list_other_tasks for the other Active tasks.",
    )
  })

  it('is refused for an unknown id, pointing at list_other_tasks', () => {
    expect(refusedReason(send(idleRunner(), 'missing'))).toBe(
      'No task missing. Call list_other_tasks for the ids of the other Active tasks.',
    )
  })

  it('is refused for a Done task', () => {
    updateTask(test.db, receiver.id, { state: TaskState.Done }, 4_000)

    expect(refusedReason(send(idleRunner(), receiver.id))).toBe(
      `${receiver.id} is Done, not Active: you can message only Active tasks.`,
    )
  })

  it('is refused for a task in another workspace', () => {
    const elsewhere = createWorkspace(test.db, { name: 'Acme Web', rootPath: '/code/acme-web' })
    const stranger = sampleTask(test.db, elsewhere.id)

    expect(refusedReason(send(idleRunner(), stranger.id))).toBe(
      `${stranger.id} is in the workspace "Acme Web", not yours ("Acme API"): you can message only tasks in your own ` +
        'workspace.',
    )
  })

  it('trips the guard at the limit, counting still-queued messages too', () => {
    fillTheHour(TASK_MESSAGES_PER_HOUR, false)

    const outcome = send(idleRunner(), receiver.id)

    expect(refusedReason(outcome)).toContain('You\'ve sent 5 messages to "Fix the flaky login test" in the last hour')
    // One less, and the message goes through.
    test.db.prepare('DELETE FROM messages WHERE body = ?').run('Message 0.')
    expect(send(idleRunner(), receiver.id)).toEqual({ kind: TaskMessageOutcomeKind.Sent, delivery: 'sent' })
  })

  it('lets the guard count the messages still queued for the receiver', () => {
    fillTheHour(TASK_MESSAGES_PER_HOUR, true)

    const runner = idleRunner()
    sendTaskMessage({ db: test.db, runner }, sender.id, { to: receiver.id, message: 'One more.' })

    expect(runner.send).not.toHaveBeenCalled()
  })

  it('queues when the receiving agent is busy', () => {
    const runner = busyRunner()

    const outcome = send(runner, receiver.id)

    expect(outcome).toEqual({ kind: TaskMessageOutcomeKind.Sent, delivery: 'queued' })
    expect(runner.queue).toHaveBeenCalledWith(
      receiver.id,
      'The login race is fixed.',
      [],
      [],
      [],
      MessageSource.Task,
      sender.id,
    )
  })

  it('tells the agent what to do when the guard trips, naming the pair', () => {
    fillTheHour(TASK_MESSAGES_PER_HOUR, false)

    const reason = refusedReason(send(idleRunner(), receiver.id))

    expect(reason).toContain("Glade's limit is 5 from one task to another in a rolling hour")
    expect(reason).toContain('Stop here: ask the user, or wait for one of the messages to age out.')
  })
})

describe('senderTaskLine', () => {
  it('names the sending task and tells the agent how to answer', () => {
    expect(senderTaskLine(test.db, sender.id)).toBe(
      'Message from Glade task "Port the chat cases" (' +
        sender.id +
        '). Reply with message_task and that id if you should.',
    )
  })

  it('says "(not set)" for a task with no title, and for one that has since been deleted', () => {
    test.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('', sender.id)
    expect(senderTaskLine(test.db, sender.id)).toContain('(not set)')
    expect(senderTaskLine(test.db, 'gone')).toContain('(not set)')
  })

  it('makes a refusal, and the message has a cap', () => {
    expect(refusedTaskMessage('no')).toEqual({ kind: TaskMessageOutcomeKind.Refused, reason: 'no' })
    expect(TASK_MESSAGE_MAX).toBeGreaterThan(0)
  })

  it('never appends a task message to the receiver without its sender', () => {
    const runner = idleRunner()
    send(runner, receiver.id)
    expect(listMessages(test.db, receiver.id)).toEqual([])
  })
})

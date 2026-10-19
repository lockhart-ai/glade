import { expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { MessageRole, MessageSource, type Message, type QueuedMessage } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import { deliverMessage } from './deliver'

const sampleMessage: Message = {
  id: 'm',
  taskId: 't',
  role: MessageRole.User,
  body: 'hi',
  turn: 1,
  createdAt: 0,
  summary: null,
  images: [],
  pastedBlocks: [],
  files: [],
  source: MessageSource.Github,
}

const sampleQueued: QueuedMessage = {
  id: 'q',
  taskId: 't',
  body: 'hi',
  createdAt: 0,
  images: [],
  pastedBlocks: [],
  files: [],
  source: MessageSource.Github,
}

it('sends when the agent is idle, tagging the message with the given source', () => {
  const send = vi.fn().mockReturnValue(sampleMessage)
  const queue = vi.fn()
  const runner = { send, queue } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  expect(deliverMessage(runner, 't', 'hi', MessageSource.Github)).toBe('sent')

  expect(send).toHaveBeenCalledWith('t', 'hi', [], [], [], MessageSource.Github, null)
  expect(queue).not.toHaveBeenCalled()
})

it("carries the sending task's id with a task message (#710)", () => {
  const send = vi.fn().mockReturnValue(sampleMessage)
  const queue = vi.fn()
  const runner = { send, queue } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  expect(deliverMessage(runner, 't', 'hi', MessageSource.Task, 'sender-1')).toBe('sent')

  expect(send).toHaveBeenCalledWith('t', 'hi', [], [], [], MessageSource.Task, 'sender-1')
  expect(queue).not.toHaveBeenCalled()
})

it('queues it instead when the runner refuses the send as busy', () => {
  const send = vi.fn().mockImplementation(() => {
    throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; queue the message instead')
  })
  const queue = vi.fn().mockReturnValue(sampleQueued)
  const runner = { send, queue } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  expect(deliverMessage(runner, 't', 'hi', MessageSource.Github)).toBe('queued')

  expect(queue).toHaveBeenCalledWith('t', 'hi', [], [], [], MessageSource.Github, null)
})

it('lets any other error through, queuing nothing', () => {
  const send = vi.fn().mockImplementation(() => {
    throw new CommandFailure(BridgeErrorCode.NotFound, 'No task t')
  })
  const queue = vi.fn()
  const runner = { send, queue } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  expect(() => deliverMessage(runner, 't', 'hi', MessageSource.Github)).toThrow('No task t')
  expect(queue).not.toHaveBeenCalled()
})

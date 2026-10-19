import { expect, it, vi } from 'vitest'
import { GithubLinkKind } from '../../shared/githubWatch'
import { BridgeErrorCode } from '../../shared/bridge'
import { MessageRole, MessageSource, type Message } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import { formatLinkChange, formatWakeMessage, linkChangeOf, wakeTasks, type LinkChange } from './wake'

const PR_CHANGE: LinkChange = {
  taskId: 't1',
  url: 'https://github.com/acme/api/pull/2537',
  kind: GithubLinkKind.PullRequest,
  number: 2537,
  title: 'Port the chat cases',
  lines: ['CI failed (13/14)', '2 new comments'],
}

const ISSUE_CHANGE: LinkChange = {
  taskId: 't1',
  url: 'https://github.com/acme/api/issues/7',
  kind: GithubLinkKind.Issue,
  number: 7,
  title: 'Flaky login test',
  lines: ['closed'],
}

it('labels a PR and an issue differently, with its title and clauses joined by semicolons', () => {
  expect(formatLinkChange(PR_CHANGE)).toBe('PR #2537 Port the chat cases: CI failed (13/14); 2 new comments')
  expect(formatLinkChange(ISSUE_CHANGE)).toBe('Issue #7 Flaky login test: closed')
})

it('builds one message, a GitHub heading then a bulleted line per link', () => {
  expect(formatWakeMessage([PR_CHANGE, ISSUE_CHANGE])).toBe(
    [
      'GitHub:',
      '- PR #2537 Port the chat cases: CI failed (13/14); 2 new comments',
      '- Issue #7 Flaky login test: closed',
    ].join('\n'),
  )
})

it('builds a LinkChange from a watch’s identity and the clauses found for it', () => {
  expect(
    linkChangeOf(
      { taskId: 't1', url: PR_CHANGE.url, kind: GithubLinkKind.PullRequest, title: 'Port the chat cases' },
      2537,
      ['closed'],
    ),
  ).toEqual({ ...PR_CHANGE, lines: ['closed'] })
})

const sampleMessage: Message = {
  id: 'm',
  taskId: 't1',
  role: MessageRole.User,
  body: 'GitHub: ...',
  turn: 1,
  createdAt: 0,
  summary: null,
  images: [],
  pastedBlocks: [],
  files: [],
  source: MessageSource.Github,
}

it('sends one batched message per task, each with only its own links', () => {
  const send = vi.fn().mockReturnValue(sampleMessage)
  const runner = { send, queue: vi.fn() } as unknown as Pick<AgentRunner, 'send' | 'queue'>
  const otherTask: LinkChange = { ...ISSUE_CHANGE, taskId: 't2' }

  wakeTasks(runner, [PR_CHANGE, otherTask])

  expect(send).toHaveBeenCalledTimes(2)
  expect(send).toHaveBeenCalledWith('t1', formatWakeMessage([PR_CHANGE]), [], [], [], MessageSource.Github, null)
  expect(send).toHaveBeenCalledWith('t2', formatWakeMessage([otherTask]), [], [], [], MessageSource.Github, null)
})

it('queues it for a busy task, and does not let one task’s failure stop another’s', () => {
  const send = vi.fn().mockImplementation((taskId: string) => {
    if (taskId === 't1') throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working')
    throw new CommandFailure(BridgeErrorCode.NotFound, 'No task t2')
  })
  const queue = vi.fn()
  const runner = { send, queue } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  expect(() => {
    wakeTasks(runner, [PR_CHANGE, { ...ISSUE_CHANGE, taskId: 't2' }])
  }).not.toThrow()

  expect(queue).toHaveBeenCalledWith('t1', formatWakeMessage([PR_CHANGE]), [], [], [], MessageSource.Github, null)
})

it('batches two links that changed for one task into one message', () => {
  const send = vi.fn()
  const runner = { send, queue: vi.fn() } as unknown as Pick<AgentRunner, 'send' | 'queue'>

  wakeTasks(runner, [PR_CHANGE, ISSUE_CHANGE])

  expect(send).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith(
    't1',
    formatWakeMessage([PR_CHANGE, ISSUE_CHANGE]),
    [],
    [],
    [],
    MessageSource.Github,
    null,
  )
})

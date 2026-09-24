import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effort } from '../../shared/domain'
import type { AgentSessionOptions } from './backend'
import { delay, init, result, say, waitForInterrupt, type AgentScript } from './scripts'
import { createTestModeAgentBackend, UnscriptedAgentError } from './test-mode-backend'

const OPTIONS: AgentSessionOptions = {
  cwd: '/tmp/acme-api',
  model: 'claude-model',
  effort: Effort.High,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Reads a session's messages in the background, and says how many have arrived. */
function drain(messages: AsyncIterable<unknown>): () => unknown[] {
  const received: unknown[] = []
  void (async () => {
    for await (const message of messages) received.push(message)
  })()
  return () => received
}

describe('createTestModeAgentBackend', () => {
  it('fails loudly when a session starts with no script', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const backend = createTestModeAgentBackend({ script: null })

    expect(() => backend.start(OPTIONS)).toThrow(UnscriptedAgentError)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Glade test mode: An agent session started in \/tmp/))
  })

  it('plays the script in each session, and is idle once every session has played its turns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const script: AgentScript = { name: 'test', turns: [[delay(100), say('Done.'), result()]] }
    const backend = createTestModeAgentBackend({ script })
    await backend.whenIdle()

    const first = backend.start(OPTIONS)
    const second = backend.start(OPTIONS)
    const received = [drain(first.messages), drain(second.messages)]
    first.send('a', 'user-1')
    second.send('b', 'user-2')
    let idle = false
    void backend.whenIdle().then(() => {
      idle = true
    })

    await vi.advanceTimersByTimeAsync(99)
    expect(idle).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(idle).toBe(true)
    expect(received.map((messages) => messages().length)).toEqual([2, 2])
    first.close()
    second.close()
  })

  it('is idle while a turn waits to be stopped, and passes the interrupt on', async () => {
    const script: AgentScript = { name: 'test', turns: [[waitForInterrupt()]] }
    const backend = createTestModeAgentBackend({ script })
    const session = backend.start(OPTIONS)
    const received = drain(session.messages)
    session.send('a', 'user-1')

    await backend.whenIdle()
    expect(received()).toEqual([])
    await session.interrupt()
    await new Promise((resolve) => setImmediate(resolve))
    expect(received()).toContainEqual(expect.objectContaining({ type: 'result', terminal_reason: 'aborted_streaming' }))
    session.close()
  })

  it('plays the script a session’s first message picks, the default for any other, for all its turns', async () => {
    const script = (reply: string): AgentScript => ({ name: reply, turns: [[say(reply), result()]] })
    const backend = createTestModeAgentBackend({
      script: script('Default.'),
      byFirstMessage: new Map([['Run the suite.', script('Suite.')]]),
    })
    const picked = backend.start(OPTIONS)
    const other = backend.start(OPTIONS)
    const received = [drain(picked.messages), drain(other.messages)]
    picked.send('Run the suite.', 'user-1')
    picked.send('And again.', 'user-2')
    other.send('Fix the bug.', 'user-3')

    await backend.whenIdle()
    const results = received.map((messages) =>
      messages()
        .filter((message) => (message as { type: string }).type === 'result')
        .map((message) => (message as { result: string }).result),
    )
    expect(results).toEqual([['Suite.', 'Suite.'], ['Default.']])
    picked.close()
    other.close()
  })

  it("picks a resumed session's script by the first message of the task it resumes", async () => {
    const script = (reply: string): AgentScript => ({ name: reply, turns: [[say(reply), result()]] })
    const backend = createTestModeAgentBackend({
      script: script('Default.'),
      byFirstMessage: new Map([['Run the suite.', script('Suite.')]]),
      firstMessageOf: (sessionId) => (sessionId === 'session-1' ? 'Run the suite.' : undefined),
    })
    const resumed = backend.start({ ...OPTIONS, resumeSessionId: 'session-1' })
    const unknown = backend.start({ ...OPTIONS, resumeSessionId: 'session-2' })
    const received = [drain(resumed.messages), drain(unknown.messages)]
    resumed.send('Carry on.', 'user-1')
    unknown.send('Carry on.', 'user-2')

    await backend.whenIdle()
    const results = received.map((messages) =>
      messages()
        .filter((message) => (message as { type: string }).type === 'result')
        .map((message) => (message as { result: string }).result),
    )
    expect(results).toEqual([['Suite.'], ['Default.']])
    resumed.close()
    unknown.close()
  })

  it('kills a session whose first message picks no script, when there is no default', async () => {
    const backend = createTestModeAgentBackend({
      script: null,
      byFirstMessage: new Map([['Run the suite.', { name: 'suite', turns: [[result()]] }]]),
    })
    const session = backend.start(OPTIONS)
    const failure = (async () => {
      for await (const message of session.messages) expect(message).toBeDefined()
    })()
    session.send('Something else.', 'user-1')

    await expect(failure).rejects.toThrow(
      new UnscriptedAgentError('No agent script for a task whose first message is "Something else.".'),
    )
    await backend.whenIdle()
    session.close()
  })

  it('passes a settings change on to the scripted session', async () => {
    const script: AgentScript = { name: 'test', turns: [[init(), result()]] }
    const backend = createTestModeAgentBackend({ script })
    const session = backend.start(OPTIONS)
    const received = drain(session.messages)
    session.configure({ model: 'claude-sample-2', effort: OPTIONS.effort })
    session.send('a', 'user-1')

    await backend.whenIdle()
    expect(received()).toContainEqual(expect.objectContaining({ type: 'system', model: 'claude-sample-2' }))
    session.close()
  })
})

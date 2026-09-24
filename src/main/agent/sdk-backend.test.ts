// The SDK adapter, with the SDK's `query()` replaced: what it passes to the SDK, and how it drives the session.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort } from '../../shared/domain'
import type { AgentSessionOptions } from './backend'
import { createSdkBackend, sdkOptions, userMessage } from './sdk-backend'

const sdk = vi.hoisted(() => {
  const session = {
    interrupt: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn<(model?: string) => Promise<void>>(() => Promise.resolve(undefined)),
    applyFlagSettings: vi.fn<(settings: unknown) => Promise<void>>(() => Promise.resolve(undefined)),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
  }
  return {
    session,
    query: vi.fn<(params: { prompt: AsyncIterable<unknown>; options: unknown }) => typeof session>(() => session),
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('runs the session in the workspace root, allowing all, with the workspace and user settings and the prompt', () => {
  expect(sdkOptions(OPTIONS)).toEqual({
    cwd: '/code/acme-api',
    model: 'claude-sample-1',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are running inside Glade.' },
    mcpServers: {},
  })
})

it('resumes a saved session and passes the MCP servers on', () => {
  const glade = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' }

  expect(sdkOptions({ ...OPTIONS, resumeSessionId: 'session-1', mcpServers: { glade } })).toMatchObject({
    resume: 'session-1',
    mcpServers: { glade },
  })
})

it("sends the user's message as a top-level message typed by a person", () => {
  expect(userMessage('Hi', 'uuid-1')).toEqual({
    type: 'user',
    uuid: 'uuid-1',
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: 'Hi' },
  })
})

it('starts one streaming-input query per session and pushes each message into it', async () => {
  const session = createSdkBackend().start(OPTIONS)

  expect(sdk.query).toHaveBeenCalledExactlyOnceWith({
    prompt: expect.anything() as unknown,
    options: sdkOptions(OPTIONS),
  })
  expect(session.messages).toBe(sdk.session)
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>

  session.send('Hi', 'uuid-1')
  session.send('Fix it.', 'uuid-2')
  await session.interrupt()
  session.close()

  const pushed: SDKUserMessage[] = []
  for await (const message of prompt) pushed.push(message)
  expect(pushed).toEqual([userMessage('Hi', 'uuid-1'), userMessage('Fix it.', 'uuid-2')])
  expect(sdk.session.interrupt).toHaveBeenCalledOnce()
  expect(sdk.session.close).toHaveBeenCalledOnce()
})

/** The messages pushed into a session's prompt: its first `count`. */
async function pushedMessages(count: number): Promise<string[]> {
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>
  const pushed: string[] = []
  for await (const message of prompt) {
    const { content } = message.message
    pushed.push(typeof content === 'string' ? content : JSON.stringify(content))
    if (pushed.length === count) break
  }
  return pushed
}

it('changes the model and effort before delivering the next message, never after', async () => {
  const order: string[] = []
  sdk.session.setModel.mockImplementation((model?: string) => {
    order.push(`model ${String(model)}`)
    return Promise.resolve(undefined)
  })
  sdk.session.applyFlagSettings.mockImplementation((settings: unknown) => {
    order.push(`flags ${JSON.stringify(settings)}`)
    return Promise.resolve(undefined)
  })
  const session = createSdkBackend().start(OPTIONS)

  session.send('Hi', 'uuid-1')
  session.configure({ model: 'claude-sample-2', effort: Effort.Max })
  session.send('Fix it.', 'uuid-2')
  const pushed = await pushedMessages(2)

  expect(pushed).toEqual(['Hi', 'Fix it.'])
  expect(order).toEqual(['model claude-sample-2', 'flags {"effortLevel":"max"}'])
  expect(sdk.session.setModel).toHaveBeenCalledBefore(sdk.session.applyFlagSettings)
})

it('still delivers the message, on the old settings, when the SDK refuses a change', async () => {
  sdk.session.setModel.mockRejectedValueOnce(new Error('model_not_found'))
  const log = { warn: vi.fn() }
  const session = createSdkBackend(log).start(OPTIONS)

  session.configure({ model: 'claude-missing', effort: Effort.Low })
  session.send('Hi', 'uuid-1')

  expect(await pushedMessages(1)).toEqual(['Hi'])
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    "Couldn't change the session to claude-missing at low effort",
    expect.any(Error),
  )
  expect(sdk.session.applyFlagSettings).not.toHaveBeenCalled()
})

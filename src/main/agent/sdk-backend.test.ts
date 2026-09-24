// The SDK adapter, with the SDK's `query()` replaced: what it passes to the SDK, and how it drives the session.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort } from '../../shared/domain'
import type { AgentSessionOptions } from './backend'
import { createSdkBackend, sdkOptions, userMessage } from './sdk-backend'

const sdk = vi.hoisted(() => {
  const session = {
    interrupt: vi.fn(() => Promise.resolve(undefined)),
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

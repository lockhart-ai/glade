// Proves the global guard (`agent-sdk-guard.ts`, wired into both Vitest projects in `vitest.config.ts`) works: a test
// that imports the real Claude Agent SDK without mocking it gets stubs that throw for everything that would start a
// Claude Code process or reach the real Claude API, and the real pure helpers for the rest.
import { createSdkMcpServer, query, startup, tool } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_SDK_GUARD_MESSAGE } from './agent-sdk-guard'

it('throws if a test calls the real Claude Agent SDK without mocking it', () => {
  expect(() => query({ prompt: 'hi' })).toThrow(AGENT_SDK_GUARD_MESSAGE)
  expect(() => startup()).toThrow(AGENT_SDK_GUARD_MESSAGE)
})

it('keeps the pure helpers real, so an in-process MCP server can still be built', () => {
  const server = createSdkMcpServer({
    name: 'echo',
    tools: [
      tool('echo', 'Echo the text.', { text: z.string() }, ({ text }) =>
        Promise.resolve({ content: [{ type: 'text', text }] }),
      ),
    ],
  })

  expect(server).toMatchObject({ type: 'sdk', name: 'echo' })
  expect(typeof server.instance.connect).toBe('function')
})

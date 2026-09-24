// Proves the global guard (`agent-sdk-guard.ts`, wired into both Vitest projects in `vitest.config.ts`) works: a test
// that imports the real Claude Agent SDK without mocking it gets a stub that throws, instead of quietly reaching the
// real Claude API.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { AGENT_SDK_GUARD_MESSAGE } from './agent-sdk-guard'

it('throws if a test calls the real Claude Agent SDK without mocking it', () => {
  expect(() => query({ prompt: 'hi' })).toThrow(AGENT_SDK_GUARD_MESSAGE)
})

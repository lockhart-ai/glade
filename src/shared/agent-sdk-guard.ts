// No test (unit, integration or e2e) may ever talk to the real Claude API; see CLAUDE.md's Tests convention. This is
// a Vitest `setupFiles` entry, wired into both projects in `vitest.config.ts`, so it runs before every test file: it
// replaces `@anthropic-ai/claude-agent-sdk` with a stub that throws if used, so a test that forgets to mock the agent
// layer fails loudly instead of quietly reaching the real API. A file that needs the SDK's real shape, like
// `sdk-backend.test.ts`, registers its own `vi.mock('@anthropic-ai/claude-agent-sdk', ...)`; Vitest keeps that file's
// own registration for its module graph, so it overrides this one there.
import { vi } from 'vitest'

/** Thrown by every export of the mocked SDK, so a test that forgets to mock the agent layer fails loudly. */
export const AGENT_SDK_GUARD_MESSAGE = 'Tests must not call the real Claude Agent SDK; mock the agent layer'

function unmocked(): never {
  throw new Error(AGENT_SDK_GUARD_MESSAGE)
}

// `query` is the only export the app calls at runtime (`src/main/agent/sdk-backend.ts`); add any other export here
// too if the app ever starts calling it.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: unmocked }))

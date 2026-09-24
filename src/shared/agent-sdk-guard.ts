// No test (unit, integration or e2e) may ever talk to the real Claude API; see CLAUDE.md's Tests convention. This is
// a Vitest `setupFiles` entry, wired into both projects in `vitest.config.ts`, so it runs before every test file. It
// keeps the real `@anthropic-ai/claude-agent-sdk` but stubs, with a function that throws, every export that starts a
// Claude Code process or reaches the API: `query`, `startup` and `DirectConnectTransport`. A test that forgets to mock
// the agent layer fails loudly instead of quietly reaching the real API. Pure helpers, like `createSdkMcpServer` and
// `tool` (which build an in-process MCP server), stay real, so the Glade tools run in tests as they do in the app.
// A file that needs its own fake of the SDK, like `sdk-backend.test.ts`, registers its own
// `vi.mock('@anthropic-ai/claude-agent-sdk', ...)`; Vitest keeps that file's own registration for its module graph,
// so it overrides this one there.
import { vi } from 'vitest'

/** Thrown by every stubbed export of the SDK, so a test that forgets to mock the agent layer fails loudly. */
export const AGENT_SDK_GUARD_MESSAGE = 'Tests must not call the real Claude Agent SDK; mock the agent layer'

function unmocked(): never {
  throw new Error(AGENT_SDK_GUARD_MESSAGE)
}

// Stub any new export that starts a process or calls the API here too.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: unmocked,
  startup: unmocked,
  DirectConnectTransport: unmocked,
}))

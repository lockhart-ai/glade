// The fake backend's sandbox side, for unit tests of what's built on it (`docs/sdk-notes.md` §15): it asks the runner
// about the sandbox's requests in their probed shapes, runs a finished `Bash` call through the session's hook, and
// records what the session was started with and every `applyFlagSettings`.
import { expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type BashCallFinished,
  type SandboxFlagSettings,
  type ToolPermissionCall,
} from './backend'
import { FakeAgentBackend } from './fake-backend'
import { networkAccessCall, outsideFileCall, FileAccess, SANDBOX_OVERRIDE_ASK_RULE } from './sandbox-requests'

const SANDBOXED: SandboxFlagSettings = {
  sandbox: { enabled: true, filesystem: { allowWrite: ['/code/acme-api'] } },
  permissions: { ask: [SANDBOX_OVERRIDE_ASK_RULE] },
}

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-model',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
  flagSettings: SANDBOXED,
}

it('asks the runner about a sandbox request in its probed shape, filling in what it leaves out', async () => {
  const asked: ToolPermissionCall[] = []
  const session = new FakeAgentBackend().start({
    ...OPTIONS,
    onToolPermission: (call) => {
      asked.push(call)
      return Promise.resolve({ behavior: ToolPermissionBehavior.Allow, byUser: true })
    },
  })

  await session.requestPermission(networkAccessCall('registry.npmjs.org', 'request-1')).answer
  await session.requestPermission(
    outsideFileCall(
      'toolu_1',
      'Read',
      { file_path: '/code/acme-shared/a.md' },
      '/code/acme-shared/a.md',
      FileAccess.Read,
    ),
  ).answer
  await session.requestPermission({ toolName: 'Edit', toolUseId: 'toolu_2', input: { file_path: 'a.md' } }).answer

  expect(asked.map(({ toolName, decisionReason, blockedPath }) => [toolName, decisionReason, blockedPath])).toEqual([
    ['SandboxNetworkAccess', null, null],
    ['Read', 'Path is outside allowed working directories', null],
    ['Edit', null, null],
  ])
  expect(session.options.flagSettings).toEqual(SANDBOXED)
})

it('runs a finished Bash call through the session’s hook, and can abort it as the SDK does', async () => {
  const heard: BashCallFinished[] = []
  const session = new FakeAgentBackend().start({
    ...OPTIONS,
    hooks: {
      onPrompt: () => PromptVerdict.Allow,
      onTurnEnded: () => undefined,
      onCompacted: () => undefined,
      onBashFinished: (call) => {
        heard.push(call)
        return Promise.resolve({ context: 'Run it again.' })
      },
    },
  })

  const finished = session.finishBash({
    toolUseId: 'toolu_1',
    command: 'cat x',
    output: 'Exit code 1\ndenied',
    failed: true,
  })
  finished.abort()

  await expect(finished.answer).resolves.toEqual({ context: 'Run it again.' })
  expect(heard).toEqual([
    {
      toolUseId: 'toolu_1',
      command: 'cat x',
      output: 'Exit code 1\ndenied',
      failed: true,
      signal: expect.any(AbortSignal) as unknown,
    },
  ])
  expect(heard[0]?.signal.aborted).toBe(true)
})

it('adds nothing for a finished Bash call when the session has no hook for it', async () => {
  const session = new FakeAgentBackend().start(OPTIONS)
  const finished = session.finishBash({ toolUseId: 'toolu_1', command: 'ls', output: '', failed: false })
  finished.abort()

  await expect(finished.answer).resolves.toEqual({ context: null })
})

it('records each applyFlagSettings, applying it at once unless the test says otherwise', async () => {
  const session = new FakeAgentBackend().start(OPTIONS)

  await session.applyFlagSettings({ permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } })
  session.onApplyFlagSettings = vi.fn(() => Promise.reject(new Error('settings_not_applied')))
  await expect(session.applyFlagSettings({ sandbox: null })).rejects.toThrow('settings_not_applied')

  expect(session.flagSettings).toEqual([
    { permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } },
    { sandbox: null },
  ])
})

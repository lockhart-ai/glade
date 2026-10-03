// The test modes' backend and the sandbox (`docs/sdk-notes.md` §15): what each session starts with and is changed to,
// the denials its commands log, and a sandboxed session's requests, for e2e specs to drive and read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type SandboxFlagSettings,
  type ToolPermissionCall,
} from './backend'
import { SANDBOX_NETWORK_TOOL, SANDBOX_OVERRIDE_ASK_RULE, SandboxOperation } from './sandbox-requests'
import { AGENT_SCRIPTS, ASKS_SANDBOX, init, result, sandboxedBash, type AgentScript } from './scripts'
import { createTestModeAgentBackend } from './test-mode-backend'

const SANDBOXED: SandboxFlagSettings = {
  sandbox: { enabled: true, filesystem: { allowRead: ['/tmp/acme-api'], allowWrite: ['/tmp/acme-api'] } },
  permissions: { ask: [SANDBOX_OVERRIDE_ASK_RULE] },
}

const OPTIONS: AgentSessionOptions = {
  cwd: '/tmp/acme-api',
  model: 'claude-model',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

afterEach(() => {
  vi.useRealTimers()
})

/** Reads a session's messages in the background. */
function drain(messages: AsyncIterable<unknown>): void {
  void (async () => {
    const received: unknown[] = []
    for await (const message of messages) received.push(message)
  })()
}

describe('createTestModeAgentBackend and the sandbox', () => {
  it('tells what each session starts with: its sandbox and permissions, when it has them', () => {
    const script: AgentScript = { name: 'test', turns: [[init(), result()]] }
    const onStart = vi.fn()
    const backend = createTestModeAgentBackend({ script, onStart })

    backend.start({ ...OPTIONS, flagSettings: SANDBOXED }).close()
    backend.start(OPTIONS).close()

    expect(onStart.mock.calls).toEqual([
      [{ systemPromptAppend: '', resumeSessionId: null, flagSettings: SANDBOXED }],
      [{ systemPromptAppend: '', resumeSessionId: null }],
    ])
  })

  it('tells of each applyFlagSettings, in order, and applies it to the session', async () => {
    const script: AgentScript = { name: 'test', turns: [[init(), result()]] }
    const onFlagSettings = vi.fn()
    const backend = createTestModeAgentBackend({ script, onFlagSettings })
    const session = backend.start({ ...OPTIONS, flagSettings: SANDBOXED })
    const changes: SandboxFlagSettings[] = [
      { permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } },
      { sandbox: null },
    ]

    for (const change of changes) await session.applyFlagSettings(change)

    expect(onFlagSettings.mock.calls).toEqual(changes.map((change) => [change]))
    session.close()
  })

  it('tells what Seatbelt logs of a sandboxed session’s commands, and nothing without a listener', async () => {
    const script: AgentScript = {
      name: 'test',
      turns: [
        [
          init(),
          sandboxedBash('cat', 'cat /tmp/acme-shared/a.txt', 'Exit code 1\ncat: denied', {
            denials: [{ process: 'cat', operation: SandboxOperation.ReadData, path: '/tmp/acme-shared/a.txt' }],
          }),
          result(),
        ],
      ],
    }
    const onSandboxLog = vi.fn()
    const listened = createTestModeAgentBackend({ script, onSandboxLog })
    const session = listened.start({ ...OPTIONS, flagSettings: SANDBOXED })
    drain(session.messages)
    session.send('Go', 'user-1')
    await listened.whenIdle()

    expect(onSandboxLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Sandbox: cat(4242) deny(1) file-read-data /tmp/acme-shared/a.txt\nCMD64_'),
    )
    session.close()

    const unheard = createTestModeAgentBackend({ script })
    const quiet = unheard.start({ ...OPTIONS, flagSettings: SANDBOXED })
    drain(quiet.messages)
    quiet.send('Go', 'user-1')
    await unheard.whenIdle()
    quiet.close()
  })

  it('plays the asks-sandbox script sandboxed: each boundary it crosses asks, in turn', async () => {
    const asked: ToolPermissionCall[] = []
    const backend = createTestModeAgentBackend({ script: AGENT_SCRIPTS['asks-sandbox'] })
    const session = backend.start({
      ...OPTIONS,
      flagSettings: SANDBOXED,
      onToolPermission: (call) => {
        asked.push(call)
        return Promise.resolve({ behavior: ToolPermissionBehavior.Allow, byUser: true })
      },
      hooks: {
        onPrompt: () => PromptVerdict.Allow,
        onTurnEnded: () => undefined,
        onCompacted: () => undefined,
        onBashFinished: ({ failed }) =>
          Promise.resolve({ context: failed ? 'You may read it now. Run it again.' : null }),
      },
    })
    drain(session.messages)
    session.send('Set things up.', 'user-1')
    await backend.whenIdle()
    await vi.waitFor(() => {
      expect(asked).toHaveLength(5)
    })

    expect(asked.map(({ toolName, input }) => `${toolName} ${JSON.stringify(input)}`)).toEqual([
      `${SANDBOX_NETWORK_TOOL} {"host":"${ASKS_SANDBOX.host}"}`,
      `WebFetch {"url":"${ASKS_SANDBOX.docs}","prompt":"Summarize the page."}`,
      `Read {"file_path":"${ASKS_SANDBOX.notes}"}`,
      `Write {"file_path":"${ASKS_SANDBOX.changelog}","content":"## Unreleased\\n\\n- Retries back off."}`,
      `Bash {"command":"${ASKS_SANDBOX.compose}","description":"Start the database","dangerouslyDisableSandbox":true}`,
    ])
    session.close()
  })
})

// The scripted session's sandbox steps (`docs/sdk-notes.md` §15): the requests and results a sandboxed session sends,
// in the shapes the P15-01 probes recorded, decided by the grants it started with and was given since.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Effort, PermissionMode } from '../../shared/domain'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type BashCallFinished,
  type BashFinishedAnswer,
  type SandboxFlagSettings,
  type ToolCallStarting,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
  type ToolStartDecision,
} from './backend'
import { AgentEventKind, createSdkMessageParser, type AgentEvent, type ToolResultEvent } from './events'
import {
  FileAccess,
  OUTSIDE_WORKING_DIRECTORIES,
  SANDBOX_NETWORK_TOOL,
  SANDBOX_OVERRIDE_ASK_RULE,
  SANDBOX_OVERRIDE_REASON,
  SandboxOperation,
  commandFailure,
  domainSuggestions,
  folderSuggestions,
  networkDenial,
  sandboxInitFailure,
  sandboxViolations,
} from './sandbox-requests'
import { ACCESS_TOOL_NAME, GLADE_SERVER, GladeTool } from './glade-tools'
import { TOOL_USE_ID_META } from './mcp-tool-caller'
import { REJECTED_TOOL_OUTPUT, ScriptedSession, type ScriptedSessionOptions } from './scripted-session'
import {
  init,
  networkAccess,
  outsideRead,
  outsideWrite,
  permission,
  requestAccess,
  result,
  sandboxedBash,
  sandboxOverride,
  say,
  ScriptStepKind,
  toolUse,
  webFetch,
  type AgentScript,
  type ScriptStep,
  type ScriptTurn,
} from './scripts'

const ROOT = '/code/acme-api'
const SHARED = '/code/acme-shared'
const HOST = 'registry.npmjs.org'

/** A sandboxed session's start, as #445 has it: the workspace root only, and the override ask rule. */
const SANDBOXED: SandboxFlagSettings = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: { denyRead: ['~', '/Users', '/Volumes'], allowRead: [ROOT], allowWrite: [ROOT] },
  },
  permissions: { ask: [SANDBOX_OVERRIDE_ASK_RULE] },
}

const SESSION: AgentSessionOptions = {
  cwd: ROOT,
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
  flagSettings: SANDBOXED,
}

/** A session the test can answer: each call it asks about waits until `give`, and is recorded. */
interface Played {
  readonly session: ScriptedSession
  readonly events: AgentEvent[]
  /** The calls asked about, in order. */
  readonly asked: ToolPermissionCall[]
  /** Answers the call asked about last. */
  readonly give: (answer: ToolPermissionAnswer) => void
  /** The `Bash` calls the session's hook heard, in order. */
  readonly finished: BashCallFinished[]
  /** Answers the hook call heard last. */
  readonly answerHook: (answer: BashFinishedAnswer) => void
  /** What Seatbelt logged. */
  readonly logged: string[]
  readonly idles: () => number
  /** Resolves when the stream ends, or with the error it failed with. */
  readonly ended: Promise<Error | null>
}

let ids: number

/** How the hook answers unless a test holds it: at once, with nothing to add. */
type HookMode = 'answers' | 'holds' | 'absent' | 'fails'

function play(
  turns: readonly ScriptTurn[],
  session: Partial<AgentSessionOptions> = {},
  hook: HookMode = 'answers',
  options: Partial<ScriptedSessionOptions> = {},
): Played {
  const script: AgentScript = { name: 'test', turns }
  const asked: ToolPermissionCall[] = []
  let give: (answer: ToolPermissionAnswer) => void = () => undefined
  const finished: BashCallFinished[] = []
  let answerHook: (answer: BashFinishedAnswer) => void = () => undefined
  const logged: string[] = []
  let idles = 0
  const onBashFinished = (call: BashCallFinished): Promise<BashFinishedAnswer> => {
    finished.push(call)
    switch (hook) {
      case 'answers':
        return Promise.resolve({ context: null })
      case 'fails':
        return Promise.reject(new Error('database is locked'))
      case 'holds':
      case 'absent':
        return new Promise((resolve) => {
          answerHook = resolve
        })
    }
  }
  const scripted = new ScriptedSession({
    script,
    session: {
      ...SESSION,
      onToolPermission: (call) => {
        asked.push(call)
        return new Promise((resolve) => {
          give = resolve
        })
      },
      ...(hook === 'absent'
        ? {}
        : {
            hooks: {
              onPrompt: () => PromptVerdict.Allow,
              onTurnEnded: () => undefined,
              onCompacted: () => undefined,
              onBashFinished,
            },
          }),
      ...session,
    },
    newId: () => `id-${String((ids += 1))}`,
    onIdle: () => {
      idles += 1
    },
    onSandboxLog: (text) => logged.push(text),
    ...options,
  })
  const events: AgentEvent[] = []
  const parse = createSdkMessageParser({ warn: () => undefined })
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of scripted.messages) events.push(...parse(message))
      return null
    } catch (error) {
      return error as Error
    }
  })()
  return {
    session: scripted,
    events,
    asked,
    give: (answer) => {
      give(answer)
    },
    finished,
    answerHook: (answer) => {
      answerHook(answer)
    },
    logged,
    idles: () => idles,
    ended,
  }
}

/** Lets the session play everything it can without time passing. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** The tool results streamed so far: output and whether it's an error. */
function results(played: Played): [string, boolean][] {
  return played.events
    .filter((event): event is ToolResultEvent => event.kind === AgentEventKind.ToolResult)
    .map((event) => [event.output, event.isError])
}

/** What the agent has said so far. */
function texts(played: Played): string[] {
  return played.events.flatMap((event) => (event.kind === AgentEventKind.Text ? [event.text] : []))
}

/** The `tool_use` ids streamed so far, by tool. */
function toolUses(played: Played): { name: string; id: string; input: unknown }[] {
  return played.events.flatMap((event) =>
    event.kind === AgentEventKind.ToolCallStarted
      ? [{ name: event.name, id: event.toolUseId, input: event.input }]
      : [],
  )
}

/** Sends a message to run the first turn, and lets it play as far as it can. */
async function start(played: Played): Promise<void> {
  played.session.send('Go', 'user-1')
  await flush()
}

const ALLOW: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: true }
const DENY: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Deny, message: 'Not that one.', byUser: true }

const turn = (...steps: ScriptStep[]): ScriptTurn => [init(), ...steps, result()]

beforeEach(() => {
  ids = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a network access step', () => {
  const install = (id = 'install') => networkAccess(id, 'npm install', HOST, 'added 312 packages in 4s')

  it('asks about the host under a fresh id, as the SDK does, while the command waits; allowed, it runs', async () => {
    const played = play([turn(install())])
    await start(played)

    expect(played.asked).toEqual([
      {
        toolName: SANDBOX_NETWORK_TOOL,
        input: { host: HOST },
        toolUseId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        agentId: null,
        title: null,
        displayName: SANDBOX_NETWORK_TOOL,
        description: `Allow network connection to ${HOST}?`,
        suggestions: domainSuggestions(HOST),
        defaultToNo: false,
        suppressAlwaysAllowRule: false,
        mcpServer: null,
        matchedAskRule: false,
        blockedPath: null,
        decisionReason: null,
        signal: expect.any(AbortSignal) as unknown,
      },
    ])
    const [bash] = toolUses(played)
    expect(bash).toEqual({ name: 'Bash', id: expect.any(String) as unknown, input: { command: 'npm install' } })
    expect(played.asked[0]?.toolUseId).not.toBe(bash?.id)
    expect(played.idles()).toBe(1)
    expect(results(played)).toEqual([])

    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([['added 312 packages in 4s', false]])
    expect(played.finished).toEqual([
      expect.objectContaining({ toolUseId: bash?.id, command: 'npm install', failed: false }),
    ])
  })

  it('keeps a host allowed for the rest of the session, as the SDK does', async () => {
    const played = play([turn(install('first'), install('again'))])
    await start(played)
    played.give(ALLOW)
    await flush()

    expect(played.asked).toHaveLength(1)
    expect(results(played)).toEqual([
      ['added 312 packages in 4s', false],
      ['added 312 packages in 4s', false],
    ])
  })

  it('fails a denied connection with the block Claude Code adds, naming the host and port, and asks again next time', async () => {
    const played = play([
      turn(
        networkAccess('push', 'git push', 'github.com', 'pushed', {
          port: 22,
          deniedOutput: commandFailure('ssh: connect to host github.com port 22: Operation not permitted', 255),
        }),
        install('first'),
        install('again'),
      ),
    ])
    await start(played)
    played.give(DENY)
    await flush()
    played.give(DENY)
    await flush()
    played.give(ALLOW)
    await flush()

    const denied = sandboxViolations([networkDenial(HOST)])
    expect(results(played)).toEqual([
      [
        `Exit code 255\nssh: connect to host github.com port 22: Operation not permitted\n${sandboxViolations([networkDenial('github.com', 22)])}`,
        true,
      ],
      [`Exit code 1\n${denied}`, true],
      ['added 312 packages in 4s', false],
    ])
    expect(played.finished.map(({ failed }) => failed)).toEqual([true, true, false])
  })

  it('reaches a granted host without asking: in the allowed domains, or a domain rule in the settings', async () => {
    const grants: SandboxFlagSettings[] = [
      { ...SANDBOXED, sandbox: { enabled: true, network: { allowedDomains: ['*.npmjs.org'] } } },
      { ...SANDBOXED, permissions: { allow: [`WebFetch(domain:${HOST})`] } },
    ]
    for (const flagSettings of grants) {
      const played = play([turn(install())], { flagSettings })
      await start(played)
      expect(played.asked).toEqual([])
      expect(results(played)).toEqual([['added 312 packages in 4s', false]])
    }
  })

  it('still asks for a host only a task rule names: the SDK merges no allowedTools into the sandbox', async () => {
    const played = play([turn(install())], { allowedRules: [{ toolName: 'WebFetch', ruleContent: `domain:${HOST}` }] })
    await start(played)

    expect(played.asked.map(({ toolName }) => toolName)).toEqual([SANDBOX_NETWORK_TOOL])
  })

  it('reaches a host granted live, and asks again once the grant is taken back', async () => {
    const played = play([
      [init(), install('first')],
      [init(), install('second')],
      [init(), install('third')],
    ])
    await played.session.applyFlagSettings({ permissions: { allow: [`WebFetch(domain:${HOST})`] } })
    await start(played)
    expect(played.asked).toEqual([])

    await played.session.applyFlagSettings({ sandbox: { enabled: true, network: { allowedDomains: [HOST] } } })
    await played.session.applyFlagSettings({ permissions: null })
    played.session.send('Again', 'user-2')
    await flush()
    expect(played.asked).toEqual([])

    await played.session.applyFlagSettings({ sandbox: null })
    played.session.send('Once more', 'user-3')
    await flush()
    expect(played.asked.map(({ toolName }) => toolName)).toEqual([SANDBOX_NETWORK_TOOL])
  })

  it('runs without asking in a session with no sandbox, or one applied off, whatever the permission mode', async () => {
    for (const session of [
      { flagSettings: {} as SandboxFlagSettings, permissionMode: PermissionMode.AskBeforeEdits },
      { flagSettings: undefined, permissionMode: PermissionMode.AskBeforeEdits },
    ]) {
      const played = play([turn(install())], session)
      await start(played)
      expect(played.asked).toEqual([])
      expect(results(played)).toEqual([['added 312 packages in 4s', false]])
    }
    const off = play([turn(install())])
    await off.session.applyFlagSettings({ sandbox: { enabled: false } })
    await start(off)
    expect(off.asked).toEqual([])
  })

  it("names the subagent whose command asks, by the id it's given or a made-up one", async () => {
    const played = play([
      turn(
        toolUse('agent', 'Agent', { description: 'Install', prompt: 'Install the dependencies.' }),
        networkAccess('install', 'npm install', HOST, 'added 312 packages', { parent: 'agent' }),
      ),
    ])
    await start(played)

    expect(played.asked[0]?.agentId).toMatch(/^a.+agent$/)
  })

  it("is denied when there's no one to ask", async () => {
    const played = play([turn(install())], { onToolPermission: undefined })
    await start(played)

    expect(results(played)).toEqual([[`Exit code 1\n${sandboxViolations([networkDenial(HOST)])}`, true]])
  })
})

describe('a WebFetch step', () => {
  const URL_TO_FETCH = 'https://docs.acme.dev/api/retries'
  const fetch = (id = 'docs') => webFetch(id, URL_TO_FETCH, 'Retries back off.', { prompt: 'What does it say?' })

  it('asks about a domain the session may not reach, in Allow all too, suggesting its rule', async () => {
    const played = play([turn(fetch())])
    await start(played)

    expect(played.asked).toEqual([
      expect.objectContaining({
        toolName: 'WebFetch',
        input: { url: URL_TO_FETCH, prompt: 'What does it say?' },
        displayName: 'WebFetch',
        description: URL_TO_FETCH,
        suggestions: domainSuggestions('docs.acme.dev'),
        decisionReason: null,
        blockedPath: null,
      }),
    ])
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([['Retries back off.', false]])
  })

  it('gives the denial as an error result', async () => {
    const played = play([turn(fetch())])
    await start(played)
    played.give(DENY)
    await flush()

    expect(results(played)).toEqual([['Not that one.', true]])
  })

  it('fetches a granted domain without asking: a task rule, the allowed domains, or a rule an answer added', async () => {
    const granted: Partial<AgentSessionOptions>[] = [
      { allowedRules: [{ toolName: 'WebFetch', ruleContent: 'domain:*.acme.dev' }] },
      { flagSettings: { sandbox: { enabled: true, network: { allowedDomains: ['docs.acme.dev'] } } } },
    ]
    for (const session of granted) {
      const played = play([turn(fetch())], session)
      await start(played)
      expect(played.asked).toEqual([])
    }
    const answered = play([turn(fetch('first'), fetch('again'))])
    await start(answered)
    answered.give({ ...ALLOW, rule: { toolName: 'WebFetch', ruleContent: 'domain:docs.acme.dev' } })
    await flush()
    expect(answered.asked).toHaveLength(1)
    expect(results(answered)).toHaveLength(2)
  })

  it('asks as any tool call does in a session with no sandbox: in the ask mode only', async () => {
    const allowAll = play([turn(webFetch('docs', URL_TO_FETCH, 'Retries back off.'))], { flagSettings: {} })
    await start(allowAll)
    expect(allowAll.asked).toEqual([])

    const askMode = play([turn(fetch())], { flagSettings: {}, permissionMode: PermissionMode.AskBeforeEdits })
    await start(askMode)
    expect(askMode.asked).toEqual([
      expect.objectContaining({ toolName: 'WebFetch', suggestions: [], description: null }),
    ])
  })

  it('fetches with a short prompt when the script gives none', async () => {
    const played = play([turn(webFetch('docs', URL_TO_FETCH, 'ok'))])
    await start(played)

    expect(played.asked[0]?.input).toEqual({ url: URL_TO_FETCH, prompt: 'Summarize the page.' })
  })
})

describe('an outside file step', () => {
  const notes = `${SHARED}/notes.md`

  it('asks about a read outside the folders the file tools may use, with the reason and its folder', async () => {
    const played = play([turn(outsideRead('notes', notes, '# Shared notes'))])
    await start(played)

    expect(played.asked).toEqual([
      expect.objectContaining({
        toolName: 'Read',
        input: { file_path: notes },
        displayName: 'Read',
        description: notes,
        decisionReason: OUTSIDE_WORKING_DIRECTORIES,
        suggestions: folderSuggestions(SHARED, FileAccess.Read),
        blockedPath: null,
        matchedAskRule: false,
      }),
    ])
    expect(folderSuggestions(SHARED, FileAccess.Read)).toEqual([
      expect.objectContaining({ rules: [{ toolName: 'Read', ruleContent: '//code/acme-shared/**' }] }),
    ])
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([['# Shared notes', false]])
  })

  it('asks about a write there, suggesting the folder as an additional directory', async () => {
    const played = play([turn(outsideWrite('changelog', `${SHARED}/CHANGELOG.md`, '- Retries.', 'Updated.'))])
    await start(played)
    played.give(DENY)
    await flush()

    expect(played.asked).toEqual([
      expect.objectContaining({
        toolName: 'Write',
        input: { file_path: `${SHARED}/CHANGELOG.md`, content: '- Retries.' },
        suggestions: folderSuggestions(SHARED, FileAccess.Write),
      }),
    ])
    expect(results(played)).toEqual([['Not that one.', true]])
  })

  it('uses the workspace, an additional directory, or a read rule’s folder without asking', async () => {
    const played = play(
      [
        turn(
          outsideRead('own', `${ROOT}/README.md`, 'readme'),
          outsideWrite('own-write', `${ROOT}/notes.md`, 'x', 'written'),
          outsideRead('docs', '/code/acme-docs/guide.md', 'guide'),
          outsideWrite('docs-write', '/code/acme-docs/guide.md', 'x', 'written'),
          outsideRead('ruled', `${SHARED}/notes.md`, 'notes'),
          outsideRead('task-ruled', '/code/acme-sdk/README.md', 'sdk'),
        ),
      ],
      {
        flagSettings: {
          ...SANDBOXED,
          permissions: { additionalDirectories: ['/code/acme-docs/'], allow: [`Read(/${SHARED}/**)`, 'Bash(ls)'] },
        },
        allowedRules: [
          { toolName: 'Read', ruleContent: '//code/acme-sdk/**' },
          { toolName: 'Read', ruleContent: 'src/**' },
          { toolName: 'Read' },
        ],
      },
    )
    await start(played)

    expect(played.asked).toEqual([])
    expect(results(played)).toHaveLength(6)
  })

  it('still asks to write where it may only read', async () => {
    const played = play([turn(outsideWrite('notes', notes, 'x', 'written'))], {
      flagSettings: { ...SANDBOXED, permissions: { allow: [`Read(/${SHARED}/**)`] } },
    })
    await start(played)

    expect(played.asked.map(({ toolName }) => toolName)).toEqual(['Write'])
  })

  it('takes back a folder granted live, but never one the session started with', async () => {
    const steps = [turn(outsideWrite('a', notes, 'x', 'ok')), turn(outsideWrite('b', notes, 'x', 'ok'))]
    const live = play(steps)
    await live.session.applyFlagSettings({ permissions: { additionalDirectories: [SHARED] } })
    await start(live)
    await live.session.applyFlagSettings({ permissions: { additionalDirectories: [] } })
    live.session.send('Again', 'user-2')
    await flush()
    expect(live.asked.map(({ toolName }) => toolName)).toEqual(['Write'])

    const started = play(steps, {
      flagSettings: { ...SANDBOXED, permissions: { additionalDirectories: [SHARED] } },
    })
    await start(started)
    await started.session.applyFlagSettings({ permissions: { additionalDirectories: [] } })
    started.session.send('Again', 'user-2')
    await flush()
    expect(started.asked).toEqual([])
  })

  it('abbreviates the home folder as Claude Code does, and reads a notebook’s path from its own field', async () => {
    const home = process.env.HOME ?? '/Users/me'
    const played = play([
      turn({
        kind: ScriptStepKind.OutsideFile,
        id: 'nb',
        tool: 'NotebookEdit',
        input: { notebook_path: `${home}/notebooks/a.ipynb`, new_source: 'x' },
        access: FileAccess.Write,
        output: 'Edited.',
      }),
    ])
    await start(played)

    expect(played.asked[0]).toMatchObject({ toolName: 'NotebookEdit', description: '~/notebooks/a.ipynb' })
  })

  it('asks as any tool call does in a session with no sandbox: in the ask mode only', async () => {
    const allowAll = play([turn(outsideRead('notes', notes, 'notes'))], { flagSettings: {} })
    await start(allowAll)
    expect(allowAll.asked).toEqual([])

    const askMode = play([turn(outsideRead('notes', notes, 'notes'))], {
      flagSettings: {},
      permissionMode: PermissionMode.AskBeforeEdits,
    })
    await start(askMode)
    expect(askMode.asked).toEqual([expect.objectContaining({ toolName: 'Read', decisionReason: null })])
  })
})

describe('a sandbox override step', () => {
  const compose = (id = 'compose') =>
    sandboxOverride(id, 'docker compose up -d', 'Container acme-db  Started', { description: 'Start the database' })
  const INPUT = { command: 'docker compose up -d', description: 'Start the database', dangerouslyDisableSandbox: true }

  it('always asks with the ask rule, even when a task rule covers the command, saying why', async () => {
    const played = play([turn(compose())], { allowedRules: [{ toolName: 'Bash', ruleContent: 'docker compose *' }] })
    await start(played)

    expect(played.asked).toEqual([
      expect.objectContaining({
        toolName: 'Bash',
        input: INPUT,
        decisionReason: SANDBOX_OVERRIDE_REASON,
        matchedAskRule: true,
        suggestions: [],
        blockedPath: null,
      }),
    ])
    played.give(ALLOW)
    await flush()
    expect(played.finished).toEqual([expect.objectContaining({ command: INPUT.command, failed: false })])
    expect(results(played)).toEqual([['Container acme-db  Started', false]])
  })

  it('runs without asking without the ask rule when a task rule covers it, as the probe found', async () => {
    const played = play([turn(compose())], {
      flagSettings: { sandbox: SANDBOXED.sandbox },
      allowedRules: [{ toolName: 'Bash', ruleContent: 'docker compose *' }],
    })
    await start(played)

    expect(played.asked).toEqual([])
    expect(results(played)).toEqual([['Container acme-db  Started', false]])
  })

  it('asks without the ask rule when nothing covers it, not saying a rule forced it', async () => {
    const played = play([turn(sandboxOverride('ls', 'ls', 'a'))], { flagSettings: { sandbox: SANDBOXED.sandbox } })
    await start(played)

    expect(played.asked).toEqual([
      expect.objectContaining({
        input: { command: 'ls', dangerouslyDisableSandbox: true },
        decisionReason: SANDBOX_OVERRIDE_REASON,
        matchedAskRule: false,
      }),
    ])
  })

  it('gives a denial as an error result, without the hook: the command never ran', async () => {
    const played = play([turn(compose())])
    await start(played)
    played.give(DENY)
    await flush()

    expect(results(played)).toEqual([['Not that one.', true]])
    expect(played.finished).toEqual([])
  })

  it('asks as any command does in a session with no sandbox: in the ask mode only', async () => {
    const allowAll = play([turn(compose())], { flagSettings: {} })
    await start(allowAll)
    expect(allowAll.asked).toEqual([])
    expect(results(allowAll)).toEqual([['Container acme-db  Started', false]])

    const askMode = play([turn(compose())], { flagSettings: {}, permissionMode: PermissionMode.AskBeforeEdits })
    await start(askMode)
    expect(askMode.asked).toEqual([expect.objectContaining({ input: INPUT, decisionReason: null })])
  })
})

describe('a sandboxed Bash step', () => {
  const config = `${SHARED}/config.json`
  const BLOCKED = commandFailure(`cat: ${config}: Operation not permitted`)
  const blocked = (options: Parameters<typeof sandboxedBash>[3] = {}) =>
    sandboxedBash('config', `cat ${config}`, BLOCKED, {
      denials: [{ process: 'cat', operation: SandboxOperation.ReadData, path: config }],
      retried: [sandboxedBash('again', `cat ${config}`, '{ "db": "staging" }', { failed: false })],
      gaveUp: [say("I couldn't read the shared config.")],
      ...options,
    })

  it('logs its denials naming the call, then holds its result while the hook decides, going idle', async () => {
    const played = play([turn(blocked())], {}, 'holds')
    await start(played)

    const [bash] = toolUses(played)
    expect(played.logged).toHaveLength(1)
    const [kernel, tag] = played.logged[0]?.split('\n') ?? []
    expect(kernel).toMatch(new RegExp(`Sandbox: cat\\(\\d+\\) deny\\(1\\) file-read-data ${config}$`))
    const encoded = /^CMD64_(.+?)_END_/.exec(tag ?? '')?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString()).toBe(bash?.id)
    expect(played.finished).toEqual([
      {
        toolUseId: bash?.id,
        command: `cat ${config}`,
        output: BLOCKED,
        failed: true,
        signal: expect.any(AbortSignal) as unknown,
      },
    ])
    expect(results(played)).toEqual([])
    expect(played.idles()).toBe(1)

    // Minutes later, the hook says the folder is allowed now: the result, then the agent runs it again.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    played.answerHook({ context: 'Glade: you may now read /code/acme-shared. Run it again.' })
    await flush()
    played.answerHook({ context: null })
    await flush()
    expect(results(played)).toEqual([
      [BLOCKED, true],
      ['{ "db": "staging" }', false],
    ])
    expect(played.finished.map(({ failed }) => failed)).toEqual([true, false])
  })

  it('gives up when the hook adds nothing, fails, or there is none', async () => {
    for (const hook of ['answers', 'fails'] as const) {
      const played = play([turn(blocked())], {}, hook)
      await start(played)
      expect(results(played)).toEqual([[BLOCKED, true]])
      expect(played.events).toContainEqual(
        expect.objectContaining({ kind: AgentEventKind.Text, text: "I couldn't read the shared config." }),
      )
    }
    const unhooked = play([turn(blocked())], {}, 'absent')
    await start(unhooked)
    expect(unhooked.finished).toEqual([])
    expect(results(unhooked)).toEqual([[BLOCKED, true]])
  })

  it('plays nothing more when there is nothing scripted for what the hook said', async () => {
    const played = play([turn(sandboxedBash('ls', 'ls /code', commandFailure('ls: /code: Operation not permitted')))])
    await start(played)

    expect(results(played)).toEqual([['Exit code 1\nls: /code: Operation not permitted', true]])
    expect(played.logged).toEqual([])
  })

  it('fails every command with why when the sandbox could not start, as Claude Code does', async () => {
    const failure = sandboxInitFailure('tlsTerminate: caCertPath and caKeyPath must be provided together')
    const played = play([turn(sandboxedBash('echo', 'echo hello', failure))])
    await start(played)

    expect(results(played)).toEqual([
      [
        'Sandbox is required but failed to initialize: tlsTerminate: caCertPath and caKeyPath must be provided together. Restart to retry.',
        true,
      ],
    ])
    expect(played.finished).toEqual([expect.objectContaining({ output: failure, failed: true })])
  })

  it('tells nothing of its denials when nothing listens to the log', async () => {
    const played = play([turn(blocked())], {}, 'answers', { onSandboxLog: undefined })
    await start(played)

    expect(played.logged).toEqual([])
    expect(results(played)).toEqual([[BLOCKED, true]])
  })
})

describe('sandbox steps together', () => {
  it('asks about two in one turn, one after the other, each once answered', async () => {
    const played = play([
      turn(
        networkAccess('install', 'npm install', HOST, 'added 312 packages'),
        outsideRead('notes', `${SHARED}/notes.md`, '# Notes'),
      ),
    ])
    await start(played)
    expect(played.asked.map(({ toolName }) => toolName)).toEqual([SANDBOX_NETWORK_TOOL])

    played.give(ALLOW)
    await flush()
    expect(played.asked.map(({ toolName }) => toolName)).toEqual([SANDBOX_NETWORK_TOOL, 'Read'])
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([
      ['added 312 packages', false],
      ['# Notes', false],
    ])
    expect(played.events.at(-1)).toMatchObject({ kind: AgentEventKind.TurnFinished })
  })

  it('withdraws an ask on Stop: its signal aborts, and the turn ends interrupted with the call rejected', async () => {
    const played = play([turn(networkAccess('install', 'npm install', HOST, 'added'), say('Never said.'))])
    await start(played)
    const [asked] = played.asked

    await played.session.interrupt()
    await flush()
    expect(asked?.signal.aborted).toBe(true)
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([[REJECTED_TOOL_OUTPUT, true]])
    expect(played.events).not.toContainEqual(expect.objectContaining({ text: 'Never said.' }))
  })

  it('stops waiting on the hook on Stop: its signal aborts, and the agent neither retries nor gives up', async () => {
    const played = play(
      [
        turn(
          sandboxedBash('config', `cat ${SHARED}/config.json`, 'blocked', {
            retried: [say('Retried.')],
            gaveUp: [say('Gave up.')],
          }),
        ),
      ],
      {},
      'holds',
    )
    await start(played)

    await played.session.interrupt()
    await flush()
    expect(played.finished[0]?.signal.aborted).toBe(true)
    played.answerHook({ context: 'Run it again.' })
    await flush()
    expect(results(played)).toEqual([[REJECTED_TOOL_OUTPUT, true]])
    expect(played.events).not.toContainEqual(expect.objectContaining({ text: 'Retried.' }))
    expect(played.events).not.toContainEqual(expect.objectContaining({ text: 'Gave up.' }))
  })

  it('stops a retry on Stop between its steps', async () => {
    const played = play(
      [
        turn(
          sandboxedBash('config', 'cat x', 'blocked', {
            retried: [sandboxedBash('again', 'cat x', 'still blocked'), say('Not reached.')],
          }),
        ),
      ],
      {},
      'holds',
    )
    await start(played)
    played.answerHook({ context: 'Run it again.' })
    await flush()
    await played.session.interrupt()
    await flush()

    expect(played.events).not.toContainEqual(expect.objectContaining({ text: 'Not reached.' }))
  })

  it('records every applyFlagSettings, in order', async () => {
    const played = play([turn()])
    const changes: SandboxFlagSettings[] = [
      { permissions: { allow: [`WebFetch(domain:${HOST})`] } },
      { sandbox: null, permissions: null },
    ]
    for (const change of changes) await expect(played.session.applyFlagSettings(change)).resolves.toBeUndefined()

    expect(played.session.flagSettingsApplied).toEqual(changes)
  })
})

describe('a malformed sandbox step', () => {
  const cases: [string, ScriptStep, string][] = [
    [
      'a host with a scheme',
      networkAccess('install', 'npm install', 'https://registry.npmjs.org/', 'ok'),
      'Malformed network_access step "install": "https://registry.npmjs.org/" isn\'t a bare host name, like "registry.npmjs.org"',
    ],
    [
      'a connection with no command',
      networkAccess('install', ' ', HOST, 'ok'),
      'Malformed network_access step "install": it has no command',
    ],
    [
      'a fetch of no URL',
      webFetch('docs', 'docs.acme.dev', 'ok'),
      'Malformed web_fetch step "docs": "docs.acme.dev" isn\'t an http or https URL',
    ],
    [
      'a fetch of a file',
      webFetch('docs', 'file:///etc/hosts', 'ok'),
      'Malformed web_fetch step "docs": "file:///etc/hosts" isn\'t an http or https URL',
    ],
    [
      'a tool that is no file tool',
      { ...outsideRead('notes', '/code/x.md', 'ok'), tool: 'Bash' },
      'Malformed outside_file step "notes": "Bash" isn\'t a file tool',
    ],
    [
      'a relative path',
      outsideRead('notes', 'notes.md', 'ok'),
      'Malformed outside_file step "notes": its file_path must be an absolute path',
    ],
    [
      'a read that writes',
      { ...outsideRead('notes', '/code/x.md', 'ok'), access: FileAccess.Write },
      'Malformed outside_file step "notes": Read doesn\'t write files',
    ],
    [
      'an override with no command',
      sandboxOverride('compose', '', 'ok'),
      'Malformed sandbox_override step "compose": it has no command',
    ],
    [
      'a blocked call with no command',
      sandboxedBash('cat', '', 'ok'),
      'Malformed sandboxed_bash step "cat": it has no command',
    ],
    [
      'a denial of no file operation',
      sandboxedBash('cat', 'cat x', 'ok', {
        denials: [{ process: 'cat', operation: 'network-outbound' as SandboxOperation, path: '/x' }],
      }),
      'Malformed sandboxed_bash step "cat": "network-outbound" isn\'t a file operation Seatbelt denies',
    ],
    [
      'a denial of a relative path',
      sandboxedBash('cat', 'cat x', 'ok', {
        denials: [{ process: 'cat', operation: SandboxOperation.WriteCreate, path: 'x' }],
      }),
      'Malformed sandboxed_bash step "cat": "x" isn\'t absolute',
    ],
  ]

  it.each(cases)('kills the session with a clear error for %s', async (_name, step, message) => {
    const played = play([turn(step)])
    await start(played)

    const error = await played.ended
    expect(error?.message).toBe(message)
    expect(played.asked).toEqual([])
  })
})

describe('a sandboxed Bash step that says what it needs', () => {
  const config = '/Users/Shared/acme-config/config.json'
  const BLOCKED = commandFailure(`cat: ${config}: Operation not permitted`)
  const reads = (id: string, options: Parameters<typeof sandboxedBash>[3] = {}) =>
    sandboxedBash(id, `cat ${config}`, '{ "db": "staging" }', {
      failed: false,
      needs: { path: config, access: FileAccess.Read, blockedOutput: BLOCKED },
      denials: [{ process: 'cat', operation: SandboxOperation.ReadData, path: config }],
      blocked: [say('Blocked: I’ll ask for it.')],
      retried: [say('Not played: the hook has nothing to say.')],
      gaveUp: [say('Not played either.')],
      ...options,
    })

  it('is blocked while the sandbox won’t let it: its blocked result, its denials, then what the agent does about it', async () => {
    const played = play([turn(reads('config'))])
    await start(played)

    expect(results(played)).toEqual([[BLOCKED, true]])
    expect(played.finished).toEqual([expect.objectContaining({ output: BLOCKED, failed: true })])
    expect(played.logged).toHaveLength(1)
    expect(texts(played)).toEqual(['Blocked: I’ll ask for it.'])
  })

  it('runs once the folder is readable, and unsandboxed: its own result, no denials, and nothing more to do', async () => {
    const granted = play([turn(reads('config'))])
    await granted.session.applyFlagSettings({
      sandbox: {
        enabled: true,
        filesystem: { denyRead: ['/Users'], allowRead: [ROOT, '/Users/Shared/acme-config'], allowWrite: [ROOT] },
      },
    })
    await start(granted)
    const unsandboxed = play([turn(reads('config'))], { flagSettings: {} })
    await start(unsandboxed)

    for (const played of [granted, unsandboxed]) {
      expect(results(played)).toEqual([['{ "db": "staging" }', false]])
      expect(played.logged).toEqual([])
      expect(texts(played)).toEqual([])
    }
  })

  it('needs a folder it may write for a write, and reads freely outside the folders it’s denied', async () => {
    const cache = '/Users/Shared/cache/uv'
    const writes = sandboxedBash('sync', 'uv sync', 'Resolved 12 packages', {
      failed: false,
      needs: { path: cache, access: FileAccess.Write, blockedOutput: commandFailure('Operation not permitted') },
    })
    const hosts = sandboxedBash('hosts', 'cat /etc/hosts', '127.0.0.1 localhost', {
      failed: false,
      needs: { path: '/etc/hosts', access: FileAccess.Read, blockedOutput: 'never' },
    })
    const played = play([turn(writes, hosts), turn(writes)])
    await start(played)

    expect(results(played)).toEqual([
      [commandFailure('Operation not permitted'), true],
      ['127.0.0.1 localhost', false],
    ])
    // Readable isn't writable; read-write is.
    await played.session.applyFlagSettings({
      sandbox: { enabled: true, filesystem: { allowRead: [ROOT, cache], allowWrite: [ROOT, cache] } },
    })
    played.session.send('Again', 'user-2')
    await flush()
    expect(results(played).at(-1)).toEqual(['Resolved 12 packages', false])
  })
})

describe('a request_access step', () => {
  const CACHE = '/Users/Shared/cache/uv'

  /** A `glade` server whose `request_access` answers as a test says, recording each call it gets. */
  function accessServer() {
    const calls: { input: unknown; toolUseId: unknown }[] = []
    let answer: (result: { text: string; isError: boolean }) => void = () => undefined
    const signals: AbortSignal[] = []
    const server = createSdkMcpServer({
      name: GLADE_SERVER,
      tools: [
        tool(
          GladeTool.RequestAccess,
          'Ask for a folder.',
          { path: z.string(), access: z.string(), reason: z.string() },
          (input, extra) => {
            const meta = (extra as { _meta?: Record<string, unknown> })._meta
            calls.push({ input, toolUseId: meta?.[TOOL_USE_ID_META] ?? null })
            signals.push((extra as { signal: AbortSignal }).signal)
            return new Promise((resolve) => {
              answer = ({ text, isError }) => {
                resolve({ content: [{ type: 'text', text }], isError })
              }
            })
          },
        ),
      ],
    })
    return {
      server,
      calls,
      signals,
      answer: (text: string, isError = false) => {
        answer({ text, isError })
      },
    }
  }

  const asks = (options: Parameters<typeof requestAccess>[4] = {}) =>
    requestAccess('access', CACHE, FileAccess.Write, 'uv needs its cache.', {
      allowed: [say('Allowed: running it again.')],
      denied: [say('Denied: carrying on without it.')],
      ...options,
    })

  it('tells the hook of the call, then waits on the tool, idle; allowed, the agent goes on to its retry', async () => {
    const glade = accessServer()
    const heard: unknown[] = []
    const played = play([turn(asks())], {
      mcpServers: { [GLADE_SERVER]: glade.server },
      hooks: {
        onPrompt: () => PromptVerdict.Allow,
        onTurnEnded: () => undefined,
        onCompacted: () => undefined,
        onAccessRequested: (call) => heard.push(call),
      },
    })
    await start(played)
    await vi.advanceTimersByTimeAsync(0)

    const [call] = toolUses(played)
    const input = { path: CACHE, access: 'write', reason: 'uv needs its cache.' }
    expect(call).toEqual({ name: ACCESS_TOOL_NAME, id: expect.any(String) as unknown, input })
    expect(heard).toEqual([{ toolUseId: call?.id, agentId: null, input }])
    // The call's id goes with the tool's request, as Claude Code sends it.
    expect(glade.calls).toEqual([{ input, toolUseId: call?.id }])
    expect(results(played)).toEqual([])
    expect(played.idles()).toBe(1)

    glade.answer('Allowed for this task: you can now read and write the folder.')
    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(results(played)).toEqual([['Allowed for this task: you can now read and write the folder.', false]])
    expect(texts(played)).toEqual(['Allowed: running it again.'])
    played.session.close()
  })

  it('denied, the agent does what it does without it; a subagent’s call names the subagent, and may send no id', async () => {
    const glade = accessServer()
    const heard: { agentId: string | null }[] = []
    const played = play(
      [
        turn(
          toolUse('agent', 'Agent', { description: 'Client generator', prompt: 'Generate it.' }),
          asks({ parent: 'agent', namesCall: false }),
        ),
      ],
      {
        mcpServers: { [GLADE_SERVER]: glade.server },
        hooks: {
          onPrompt: () => PromptVerdict.Allow,
          onTurnEnded: () => undefined,
          onCompacted: () => undefined,
          onAccessRequested: (call) => heard.push(call),
        },
      },
    )
    await start(played)
    await vi.advanceTimersByTimeAsync(0)

    expect(heard).toEqual([expect.objectContaining({ agentId: expect.stringMatching(/agent$/) as unknown })])
    expect(glade.calls).toEqual([expect.objectContaining({ toolUseId: null })])

    glade.answer('Denied: the user didn’t allow it.', true)
    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(results(played).at(-1)).toEqual(['Denied: the user didn’t allow it.', true])
    expect(texts(played)).toEqual(['Denied: carrying on without it.'])
    played.session.close()
  })

  it('an interrupt cancels the call it waits on, and nothing more plays', async () => {
    const glade = accessServer()
    const played = play([turn(asks())], { mcpServers: { [GLADE_SERVER]: glade.server } }, 'absent')
    await start(played)
    await vi.advanceTimersByTimeAsync(0)
    expect(glade.calls).toHaveLength(1)

    await played.session.interrupt()
    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(glade.signals[0]?.aborted).toBe(true)
    expect(texts(played)).toEqual([])
    // An answer that comes too late changes nothing.
    glade.answer('Allowed.')
    await flush()
    expect(texts(played)).toEqual([])
    played.session.close()
  })

  it('fails the session when the tool can’t be called at all', async () => {
    const played = play([turn(asks())])
    await start(played)
    await vi.advanceTimersByTimeAsync(0)

    await expect(played.ended).resolves.toMatchObject({ message: 'No in-process MCP server named glade' })
  })
})

// #514: Claude Code puts a call to the session's `PreToolUse` hook before it matches a single rule, in every permission
// mode. The scripted session plays that for the tools the sandbox bounds, so a spec can show Glade deciding a call that
// a rule in the user's own settings would have let through.
describe('the hook on a call about to run', () => {
  /** A session whose hook the test answers: each call it hears waits until `decide`, and is recorded. */
  function hooked(turns: readonly ScriptTurn[], session: Partial<AgentSessionOptions> = {}) {
    const heard: ToolCallStarting[] = []
    let decide: (decision: ToolStartDecision | null) => void = () => undefined
    const played = play(turns, {
      hooks: {
        onPrompt: () => PromptVerdict.Allow,
        onTurnEnded: () => undefined,
        onCompacted: () => undefined,
        onBashFinished: () => Promise.resolve({ context: null }),
        onToolStarting: (call) => {
          heard.push(call)
          return new Promise((resolve) => {
            decide = resolve
          })
        },
      },
      ...session,
    })
    return {
      ...played,
      heard,
      decide: async (decision: ToolStartDecision | null): Promise<void> => {
        decide(decision)
        await flush()
      },
    }
  }
  const REFUSED: ToolStartDecision = {
    behavior: ToolPermissionBehavior.Deny,
    message: 'Glade refused this.',
    byUser: false,
  }
  const LET_THROUGH: ToolStartDecision = { behavior: ToolPermissionBehavior.Allow, byUser: true }
  const PLIST = '/Users/me/Library/LaunchAgents/dev.acme.sample.plist'

  it('hears of every call to a tool the sandbox bounds before anything else is decided, and waits on it, idle', async () => {
    const played = hooked([
      turn(
        outsideRead('read', `${SHARED}/notes.md`, '# Notes'),
        outsideWrite('write', `${SHARED}/out.md`, 'x', 'Wrote it.'),
        webFetch('fetch', 'https://docs.acme.dev/x', 'A page.'),
        sandboxedBash('test', 'npm test', 'ok', { failed: false }),
        networkAccess('install', 'npm install', HOST, 'added 312 packages'),
        sandboxOverride('up', 'docker compose up -d', 'Started.'),
      ),
    ])
    await start(played)

    // The first call waits on the hook, with nobody asked about it yet.
    expect(played.heard.map(({ toolName }) => toolName)).toEqual(['Read'])
    expect(played.heard[0]).toMatchObject({
      toolName: 'Read',
      input: { file_path: `${SHARED}/notes.md` },
      toolUseId: toolUses(played)[0]?.id,
      agentId: null,
    })
    expect(played.asked).toEqual([])
    expect(played.idles()).toBe(1)
    expect(results(played)).toEqual([])

    // Each allowed in turn, the next is heard: the tool, and the input the model sent.
    for (let call = 0; call < 5; call += 1) await played.decide(LET_THROUGH)
    // The install's connection is still Claude Code's to ask about: it's no tool call, and the hook never hears of it.
    expect(played.asked.map(({ toolName }) => toolName)).toEqual([SANDBOX_NETWORK_TOOL])
    played.give(ALLOW)
    await flush()
    expect(played.heard.map(({ toolName, input }) => [toolName, input])).toEqual([
      ['Read', { file_path: `${SHARED}/notes.md` }],
      ['Write', { file_path: `${SHARED}/out.md`, content: 'x' }],
      ['WebFetch', { url: 'https://docs.acme.dev/x', prompt: expect.any(String) as unknown }],
      ['Bash', { command: 'npm test' }],
      ['Bash', { command: 'npm install' }],
      ['Bash', { command: 'docker compose up -d', dangerouslyDisableSandbox: true }],
    ])
  })

  it('doesn’t run a call the hook refuses, and gives the agent its message', async () => {
    const played = hooked([
      turn(
        outsideWrite('write', PLIST, '<plist/>', 'Wrote it.'),
        webFetch('fetch', 'https://paste.example/upload', 'Uploaded.'),
        sandboxedBash('docker', 'docker run alpine', 'ran', { failed: false }),
        networkAccess('install', 'npm install', HOST, 'added 312 packages'),
        sandboxOverride('up', 'docker compose up -d', 'Started.'),
        permission('edit', 'Edit', { file_path: '/Users/me/.zshrc' }, 'Edited.'),
      ),
    ])
    await start(played)

    for (let call = 0; call < 6; call += 1) await played.decide(REFUSED)

    expect(results(played)).toEqual(Array.from({ length: 6 }, () => ['Glade refused this.', true]))
    // Claude Code never got as far as asking about any of them, and no command's result reached its other hook.
    expect(played.asked).toEqual([])
    expect(played.finished).toEqual([])
  })

  // The review's shape: `permissions.allow: ["Write"]` or `["WebFetch"]` in the user's settings. Claude Code never
  // asks about the call (`canUseTool`), so only the hook stands in its way.
  it('is all that stops a call a rule in the user’s own settings allows', async () => {
    const write = { ...outsideWrite('write', PLIST, '<plist/>', 'Wrote it.'), settingsAllow: true }
    const fetch = webFetch('fetch', 'https://paste.example/upload', 'Uploaded.', { settingsAllow: true })

    // With no hook to decide it, the call runs unasked: what the review found.
    const unguarded = play([turn(write, fetch)])
    await start(unguarded)
    expect(unguarded.asked).toEqual([])
    expect(results(unguarded)).toEqual([
      ['Wrote it.', false],
      ['Uploaded.', false],
    ])

    // With it, the call waits, and doesn't run when the hook says no.
    const guarded = hooked([turn(write, fetch)])
    await start(guarded)
    expect(results(guarded)).toEqual([])
    await guarded.decide(REFUSED)
    await guarded.decide(REFUSED)
    expect(results(guarded)).toEqual([
      ['Glade refused this.', true],
      ['Glade refused this.', true],
    ])
    expect(guarded.asked).toEqual([])
  })

  it('runs a file tool’s or WebFetch’s call the hook lets through, without asking about it again', async () => {
    const played = hooked([
      turn(
        outsideRead('read', `${SHARED}/notes.md`, '# Notes'),
        webFetch('fetch', 'https://docs.acme.dev/x', 'A page.'),
      ),
    ])
    await start(played)

    await played.decide(LET_THROUGH)
    await played.decide(LET_THROUGH)

    expect(played.asked).toEqual([])
    expect(results(played)).toEqual([
      ['# Notes', false],
      ['A page.', false],
    ])
  })

  it('leaves a call the hook says nothing of to Claude Code, which asks as it always has', async () => {
    const played = hooked([turn(outsideRead('read', `${SHARED}/notes.md`, '# Notes'))])
    await start(played)

    await played.decide(null)

    expect(played.asked.map(({ toolName, decisionReason }) => [toolName, decisionReason])).toEqual([
      ['Read', OUTSIDE_WORKING_DIRECTORIES],
    ])
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([['# Notes', false]])
  })

  it('still has Claude Code ask about leaving the sandbox once the hook lets it through: the ask rule holds', async () => {
    const played = hooked([turn(sandboxOverride('up', 'docker compose up -d', 'Started.'))])
    await start(played)

    await played.decide(LET_THROUGH)

    expect(played.asked).toHaveLength(1)
    expect(played.asked[0]).toMatchObject({
      toolName: 'Bash',
      toolUseId: played.heard[0]?.toolUseId,
      matchedAskRule: true,
      decisionReason: SANDBOX_OVERRIDE_REASON,
    })
    played.give(ALLOW)
    await flush()
    expect(results(played)).toEqual([['Started.', false]])
  })

  it('names the subagent whose call it is', async () => {
    const played = hooked([
      turn(toolUse('agent', 'Agent', { description: 'Upgrade guide' }), outsideRead('read', PLIST, 'x', 'agent')),
    ])
    await start(played)

    expect(played.heard[0]?.agentId).toMatch(/^a.*agent$/)
  })

  it('hears nothing of a tool the sandbox doesn’t bound', async () => {
    const played = hooked([turn(permission('issue', 'mcp__github__create_issue', { title: 'Sample' }, 'Created.'))], {
      permissionMode: PermissionMode.AskBeforeEdits,
    })
    await start(played)

    expect(played.heard).toEqual([])
    expect(played.asked.map(({ toolName }) => toolName)).toEqual(['mcp__github__create_issue'])
  })

  it('puts a tool call that asks permission to the hook first, then to Claude Code’s own rules', async () => {
    const played = hooked([turn(permission('edit', 'Edit', { file_path: `${ROOT}/a.ts` }, 'Edited.'))])
    await start(played)

    expect(played.heard.map(({ toolName }) => toolName)).toEqual(['Edit'])
    await played.decide(null)
    // In Allow all, Claude Code lets it through by itself.
    expect(played.asked).toEqual([])
    expect(results(played)).toEqual([['Edited.', false]])
  })

  it('ends the turn interrupted when Stop comes while the hook decides: its signal aborts, and nothing runs', async () => {
    const played = hooked([turn(outsideWrite('write', PLIST, '<plist/>', 'Wrote it.'), say('Done.'))])
    await start(played)
    const [call] = played.heard

    await played.session.interrupt()
    await flush()
    await played.decide(LET_THROUGH)

    expect(call?.signal.aborted).toBe(true)
    expect(results(played)).toEqual([[REJECTED_TOOL_OUTPUT, true]])
    expect(texts(played)).not.toContain('Done.')
  })

  it('goes on at once, without going idle, when the hook answers at once', async () => {
    const turns = [turn(sandboxedBash('test', 'npm test', 'ok', { failed: false }))]
    const unhooked = play(turns, {}, 'absent')
    const played = play(turns, {
      hooks: {
        onPrompt: () => PromptVerdict.Allow,
        onTurnEnded: () => undefined,
        onCompacted: () => undefined,
        onToolStarting: () => Promise.resolve(null),
      },
    })
    await start(unhooked)
    await start(played)

    expect(results(played)).toEqual([['ok', false]])
    // Idle only as a session with no such hook is: once its turn is over.
    expect(played.idles()).toBe(unhooked.idles())
  })
})

// The scripted session's `Shell` step: a `Bash` call that really runs, after the session's `PreToolUse` hook.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { PromptVerdict, type AgentSessionOptions, type BashCallStarting } from './backend'
import { REJECTED_TOOL_OUTPUT, ScriptedSession } from './scripted-session'
import { init, result, shell, toolResult, toolUse, waitForInterrupt, type ScriptTurn } from './scripts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'glade-scripted-shell-')))
  mkdirSync(join(dir, 'acme-api'))
  mkdirSync(join(dir, 'acme-api-docs'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Played {
  readonly session: ScriptedSession
  readonly raw: Record<string, unknown>[]
  readonly started: BashCallStarting[]
  readonly idle: Promise<void>
}

function play(turn: ScriptTurn, hooks = true): Played {
  const started: BashCallStarting[] = []
  const session: AgentSessionOptions = {
    cwd: join(dir, 'acme-api'),
    model: 'claude-sample-1',
    effort: Effort.High,
    permissionMode: PermissionMode.AllowAll,
    resumeSessionId: null,
    systemPromptAppend: '',
    mcpServers: {},
    ...(hooks
      ? {
          hooks: {
            onPrompt: () => PromptVerdict.Allow,
            onTurnEnded: () => undefined,
            onBashStarting: (call) => {
              started.push(call)
              return Promise.resolve()
            },
          },
        }
      : {}),
  }
  let done = (): void => undefined
  const idle = new Promise<void>((resolve) => {
    done = resolve
  })
  const scripted = new ScriptedSession({
    script: { name: 'test', turns: [turn] },
    session,
    onIdle: () => {
      done()
    },
  })
  const raw: Record<string, unknown>[] = []
  void (async () => {
    for await (const message of scripted.messages) raw.push(message as Record<string, unknown>)
  })()
  scripted.send('Commit it.', 'u1')
  return { session: scripted, raw, started, idle }
}

/** The tool calls and results streamed, as [kind, id, parent, text]. */
function calls(raw: readonly Record<string, unknown>[]): unknown[] {
  return raw.flatMap((message) => {
    const content = (Reflect.get(Object(message.message), 'content') ?? []) as Record<string, unknown>[]
    const parent = message.parent_tool_use_id
    return content.flatMap((block) => {
      if (block.type === 'tool_use') return [['use', block.id, parent, Reflect.get(Object(block.input), 'command')]]
      if (block.type === 'tool_result') return [['result', block.tool_use_id, parent, block.content, block.is_error]]
      return []
    })
  })
}

it('runs a Bash call’s command for real, after telling the PreToolUse hook where and what, a subagent’s too', async () => {
  const { raw, started, idle } = play([
    init(),
    shell('here', 'pwd', 'Say where'),
    toolUse('docs', 'Agent', { description: 'Update the docs' }),
    shell('there', 'pwd && exit 2', 'Say where, and fail', { cwd: '../acme-api-docs', parent: 'docs' }),
    toolResult('docs', 'Done.'),
    result(),
  ])
  await idle

  const [here, docs, there] = calls(raw).filter((call) => Array.isArray(call) && call[0] === 'use') as string[][]
  expect(started).toEqual([
    { toolUseId: here?.[1], cwd: join(dir, 'acme-api'), command: 'pwd' },
    { toolUseId: there?.[1], cwd: join(dir, 'acme-api-docs'), command: 'pwd && exit 2' },
  ])
  expect(calls(raw)).toEqual([
    ['use', here?.[1], null, 'pwd'],
    ['result', here?.[1], null, `${join(dir, 'acme-api')}\n`, false],
    ['use', docs?.[1], null, undefined],
    ['use', there?.[1], docs?.[1], 'pwd && exit 2'],
    ['result', there?.[1], docs?.[1], `${join(dir, 'acme-api-docs')}\n`, true],
    ['result', docs?.[1], null, 'Done.', false],
  ])
})

it('runs it with no one to tell, when the session has no hooks', async () => {
  const { raw, idle } = play([init(), shell('here', 'echo hi', 'Say hi'), result()], false)
  await idle
  expect(calls(raw)).toContainEqual(['result', expect.any(String), null, 'hi\n', false])
})

it('gives an interrupted call the SDK’s rejection, not its command’s output', async () => {
  const { session, raw, idle } = play([init(), shell('slow', 'sleep 0.3 && echo late', 'Wait'), waitForInterrupt()])
  await new Promise((resolve) => setTimeout(resolve, 50))
  await session.interrupt()
  await idle
  await new Promise((resolve) => setTimeout(resolve, 400))
  const results = calls(raw).filter((call) => Array.isArray(call) && call[0] === 'result')
  expect(results).toEqual([['result', expect.any(String), null, REJECTED_TOOL_OUTPUT, true]])
})

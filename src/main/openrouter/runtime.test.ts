import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import type { AgentSessionOptions } from '../agent/backend'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setOpenRouterChoice } from '../db/repositories/openrouter'
import { OpenRouterClient } from './client'
import { createOpenRouterRelay } from './relay'
import { openRouterRuntime } from './runtime'
import { OpenRouterService } from './service'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { beginTranscriptImport, hasTranscript, markTranscriptFailed, sqliteSessionStore } from './transcripts'
import { openRouterSdkModel } from './sdk-model'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ importSessionToStore: vi.fn() }))
vi.mock('./relay', () => ({ createOpenRouterRelay: vi.fn() }))

let database: TestDatabase
let service: OpenRouterService
let dir: string
const relayClose = vi.fn()
const options: AgentSessionOptions = {
  model: SAMPLE_CHOICE.id,
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  cwd: '/code/sample',
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}
const inherited = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CLAUDE_CODE_OAUTH_TOKEN: 'account-token',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CONFIG_DIR: '/sample/claude',
  OPENROUTER_API_KEY: 'inference-key',
  GLADE_CONTROL_URL: 'http://127.0.0.1:4321',
}

beforeEach(async () => {
  database = openTestDatabase()
  dir = mkdtempSync(join(tmpdir(), 'glade-or-runtime-'))
  const client = new OpenRouterClient(vi.fn())
  vi.spyOn(client, 'catalog').mockResolvedValue({ models: [SAMPLE_MODEL], providers: [SAMPLE_PROVIDER] })
  vi.spyOn(client, 'endpoints').mockResolvedValue([SAMPLE_PROVIDER])
  service = new OpenRouterService({
    db: database.db,
    emit: () => undefined,
    client,
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (key) => Buffer.from(key),
      decryptString: (key) => key.toString(),
    },
  })
  await service.connect('inference-key')
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  vi.mocked(createOpenRouterRelay).mockResolvedValue({
    url: 'http://127.0.0.1:1234',
    token: 'temporary-token',
    close: relayClose,
  })
  vi.mocked(importSessionToStore).mockReset()
})
afterEach(() => {
  database.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('isolates route credentials, aliases and configuration, preserving the task tools and actual metadata', async () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  const prepared = await runtime.prepare({ ...options, taskId: task.id }, inherited)
  expect(prepared.env).toMatchObject({
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
    ANTHROPIC_AUTH_TOKEN: 'temporary-token',
    ANTHROPIC_MODEL: openRouterSdkModel(SAMPLE_CHOICE.id),
    CLAUDE_CODE_SUBAGENT_MODEL: '',
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '',
    CLAUDE_CONFIG_DIR: join(dir, 'openrouter-sdk'),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
    GLADE_CONTROL_URL: inherited.GLADE_CONTROL_URL,
  })
  expect(JSON.stringify(prepared.env)).not.toMatch(/anthropic-key|account-token|inference-key/)
  expect(prepared.env).toMatchObject({
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    OPENROUTER_API_KEY: '',
  })
  expect(prepared.publishModels).toBe(false)
  const relay = vi.mocked(createOpenRouterRelay).mock.calls.at(-1)?.[0]
  expect(relay?.key()).toBe('inference-key')
  const refreshed = vi.spyOn(service, 'refreshUsage').mockResolvedValue({ connected: true, reading: null, error: null })
  relay?.onComplete?.(200)
  expect(refreshed).toHaveBeenCalled()
  prepared.close()
  expect(relayClose).toHaveBeenCalled()
})

it('gives each independently routed session its own model and context window', async () => {
  const child = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/small@sample-host',
    model: { ...SAMPLE_MODEL, id: 'sample/small', contextLength: 64_000 },
  }
  setOpenRouterChoice(database.db, child)
  const disabled = {
    ...child,
    id: 'openrouter:sample/disabled@sample-host',
    model: { ...child.model, contextLength: 16_000 },
    enabled: false,
  }
  setOpenRouterChoice(database.db, disabled)
  vi.spyOn(service, 'endpoints').mockResolvedValue([SAMPLE_PROVIDER])
  const prepared = await openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() }).prepare(
    options,
    inherited,
  )
  expect(prepared.env).toMatchObject({
    CLAUDE_CODE_SUBAGENT_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: openRouterSdkModel(SAMPLE_CHOICE.id),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
  })
  expect(vi.mocked(createOpenRouterRelay).mock.calls.at(-1)?.[0].choices).toEqual([SAMPLE_CHOICE])
  const childSession = await openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() }).prepare(
    { ...options, model: child.id },
    inherited,
  )
  expect(childSession.contextWindowTokens).toBe(64_000)
  expect(vi.mocked(createOpenRouterRelay).mock.calls.at(-1)?.[0].choices).toEqual([child])
  prepared.close()
  childSession.close()
})

it('keeps account configuration and login intact without passing an OpenRouter key to account agents', async () => {
  const prepared = await openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() }).prepare(
    { ...options, model: 'claude-sonnet-5' },
    inherited,
  )
  expect(prepared.env).toMatchObject({
    CLAUDE_CONFIG_DIR: inherited.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_OAUTH_TOKEN: 'account-token',
  })
  expect(prepared.env.OPENROUTER_API_KEY).toBe('')
  expect(prepared.publishModels).toBe(true)
  prepared.close()
})

it('leaves both new and resumed Claude-only tasks on their ordinary files, without importing history', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  for (const resumeSessionId of [null, 'legacy']) {
    const account = await runtime.prepare(
      { ...options, model: 'sonnet', resumeSessionId },
      { ...inherited, CLAUDE_CONFIG_DIR: '' },
    )
    expect(account.sessionStore).toBeUndefined()
    expect(account.onMirrorError).toBeUndefined()
  }
  expect(importSessionToStore).not.toHaveBeenCalled()
  vi.mocked(importSessionToStore).mockRejectedValueOnce(new Error('Unreadable transcript'))
  await expect(
    runtime.prepare({ ...options, resumeSessionId: 'legacy' }, { ...inherited, CLAUDE_CONFIG_DIR: '' }),
  ).rejects.toThrow('Unreadable transcript')
})

it('retries a partial legacy import without resuming its prefix, while Claude keeps its original files', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  vi.mocked(importSessionToStore).mockImplementationOnce(async (id, store) => {
    await store.append({ projectKey: 'sample', sessionId: id }, [{ type: 'user', uuid: 'partial' }])
    throw new Error('Import interrupted')
  })
  await expect(
    runtime.prepare({ ...options, resumeSessionId: 'saved' }, { ...inherited, CLAUDE_CONFIG_DIR: '' }),
  ).rejects.toThrow('Import interrupted')
  expect(
    (
      await runtime.prepare(
        { ...options, model: 'sonnet', resumeSessionId: 'saved' },
        { ...inherited, CLAUDE_CONFIG_DIR: '' },
      )
    ).sessionStore,
  ).toBeUndefined()
  vi.mocked(importSessionToStore).mockImplementationOnce(async (id, store) => {
    await store.append({ projectKey: 'sample', sessionId: id }, [{ type: 'user', uuid: 'complete' }])
  })
  const prepared = await runtime.prepare(
    { ...options, resumeSessionId: 'saved' },
    { ...inherited, CLAUDE_CONFIG_DIR: '' },
  )
  expect(await prepared.sessionStore?.load({ projectKey: 'sample', sessionId: 'saved' })).toEqual([
    { type: 'user', uuid: 'complete' },
  ])
  expect(importSessionToStore).toHaveBeenCalledTimes(2)
})

it('imports legacy main and child history once, and never silently starts without the saved context', async () => {
  vi.mocked(importSessionToStore).mockImplementation(async (id, store) => {
    await store.append({ projectKey: '-code-sample', sessionId: id }, [
      {
        type: 'user',
        uuid: 'original',
        message: { content: [{ type: 'tool_result', content: 'Preserved result', tool_use_id: 'read-1' }] },
      },
    ])
  })
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  await runtime.prepare({ ...options, resumeSessionId: 'saved-session' }, { ...inherited, CLAUDE_CONFIG_DIR: '' })
  await runtime.prepare({ ...options, resumeSessionId: 'saved-session' }, { ...inherited, CLAUDE_CONFIG_DIR: '' })
  expect(importSessionToStore).toHaveBeenCalledOnce()
  expect(importSessionToStore).toHaveBeenCalledWith('saved-session', expect.anything(), {
    dir: options.cwd,
    includeSubagents: true,
  })
  expect(
    await sqliteSessionStore(database.db).load({ projectKey: '-code-sample', sessionId: 'saved-session' }),
  ).toMatchObject([{ uuid: 'original' }])
  const returned = await runtime.prepare(
    { ...options, model: 'sonnet', resumeSessionId: 'saved-session' },
    { ...inherited, CLAUDE_CONFIG_DIR: join(dir, 'unreadable-claude') },
  )
  expect(returned.sessionStore).toBeDefined()
  returned.onMirrorError?.('saved-session')
  await expect(
    runtime.prepare({ ...options, resumeSessionId: 'saved-session' }, { ...inherited, CLAUDE_CONFIG_DIR: '' }),
  ).rejects.toThrow('history could not be recovered')
  vi.mocked(importSessionToStore).mockResolvedValue()
  await expect(
    runtime.prepare({ ...options, resumeSessionId: 'missing-history' }, { ...inherited, CLAUDE_CONFIG_DIR: '' }),
  ).rejects.toThrow('saved SDK history')
})

it('discards uncommitted handoff copies and reimports Claude turns written after a cancelled handoff', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  const env = { ...inherited, CLAUDE_CONFIG_DIR: '' }
  vi.mocked(importSessionToStore).mockImplementation(async (id, store) => {
    await store.append({ projectKey: 'sample', sessionId: id }, [{ type: 'user', uuid: 'first' }])
  })
  const pending = await runtime.prepare({ ...options, resumeSessionId: 'saved', provisional: true }, env)
  expect(hasTranscript(database.db, 'saved')).toBe(false)
  expect(
    (await runtime.prepare({ ...options, model: 'sonnet', resumeSessionId: 'saved' }, env)).sessionStore,
  ).toBeUndefined()
  pending.close()
  expect(await sqliteSessionStore(database.db).load({ projectKey: 'sample', sessionId: 'saved' })).toBeNull()
  vi.mocked(importSessionToStore).mockImplementation(async (id, store) => {
    await store.append({ projectKey: 'sample', sessionId: id }, [
      { type: 'user', uuid: 'first' },
      { type: 'assistant', uuid: 'later-Claude-turn' },
    ])
  })
  const restarted = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  const accepted = await restarted.prepare({ ...options, resumeSessionId: 'saved', provisional: true }, env)
  accepted.activate?.()
  accepted.close()
  expect(hasTranscript(database.db, 'saved')).toBe(true)
  expect(await accepted.sessionStore?.load({ projectKey: 'sample', sessionId: 'saved' })).toHaveLength(2)
  vi.mocked(createOpenRouterRelay).mockRejectedValueOnce(new Error('Relay failed after import'))
  await expect(runtime.prepare({ ...options, resumeSessionId: 'other', provisional: true }, env)).rejects.toThrow(
    'Relay failed',
  )
  expect(hasTranscript(database.db, 'other')).toBe(false)
})

it('recovers a failed mirror from complete local SDK history and honors a login-shell config directory', async () => {
  const config = join(dir, 'custom-claude')
  mkdirSync(join(config, 'projects', 'sample'), { recursive: true })
  writeFileSync(
    join(config, 'projects', 'sample', 'saved.jsonl'),
    '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1","thinking":{"signature":"sample"}}\n',
  )
  markTranscriptFailed(database.db, 'saved', null, config)
  // A crash during recovery must retain the complete-file source for another attempt.
  beginTranscriptImport(database.db, 'saved', null, config)
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  const pending = await runtime.prepare({ ...options, resumeSessionId: 'saved', provisional: true }, inherited)
  pending.close()
  expect(database.db.prepare('SELECT reason FROM sdk_transcript_failures').get()).toEqual({ reason: 'mirror_error' })
  const recovered = await runtime.prepare({ ...options, model: 'sonnet', resumeSessionId: 'saved' }, inherited)
  expect(await recovered.sessionStore?.load({ projectKey: 'sample', sessionId: 'saved' })).toHaveLength(2)
  expect(database.db.prepare('SELECT reason FROM sdk_transcript_failures').get()).toBeUndefined()
  expect(importSessionToStore).not.toHaveBeenCalled()
  writeFileSync(join(config, 'projects', 'sample', 'legacy.jsonl'), '{"type":"user","uuid":"u2"}')
  const imported = await runtime.prepare(
    { ...options, resumeSessionId: 'legacy' },
    { ...inherited, CLAUDE_CONFIG_DIR: config },
  )
  expect(await imported.sessionStore?.load({ projectKey: 'sample', sessionId: 'legacy' })).toEqual([
    { type: 'user', uuid: 'u2' },
  ])
  const account = await runtime.prepare(
    { ...options, model: 'sonnet' },
    { ...inherited, CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
  )
  expect(account.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku')
})

it('serializes imports for one task while keeping incomplete copies out of ordinary Claude sessions', async () => {
  let finish: () => void = () => undefined
  vi.mocked(importSessionToStore).mockImplementation(async (id, store) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    await store.append({ projectKey: 'sample', sessionId: id }, [{ type: 'user', uuid: 'u1' }])
  })
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  const env = { ...inherited, CLAUDE_CONFIG_DIR: '' }
  const first = runtime.prepare({ ...options, resumeSessionId: 'saved' }, env)
  await expect(runtime.prepare({ ...options, resumeSessionId: 'saved' }, env)).rejects.toThrow('still being loaded')
  finish()
  await first
})

it('refuses missing and disabled parent routes before spawning an SDK process', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  await expect(runtime.prepare({ ...options, model: 'openrouter:missing' }, inherited)).rejects.toThrow('Enable this')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  await expect(runtime.prepare(options, inherited)).rejects.toThrow('Enable this')
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
})

it('retains the previous mirror when rebuilding fails, through repeated starts, then replaces it after recovery', async () => {
  const key = { projectKey: 'sample', sessionId: 'failed-rebuild' }
  const store = sqliteSessionStore(database.db)
  const kept = [
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1', message: 'saved history' },
  ]
  await store.append(key, kept)
  const config = join(dir, 'recover-config')
  markTranscriptFailed(database.db, key.sessionId, null, config)
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir, request: vi.fn() })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(runtime.prepare({ ...options, resumeSessionId: key.sessionId }, inherited)).rejects.toThrow(
      'could not be recovered',
    )
    expect(await store.load(key)).toEqual(kept)
  }
  mkdirSync(join(config, 'projects', 'sample'), { recursive: true })
  writeFileSync(
    join(config, 'projects', 'sample', `${key.sessionId}.jsonl`),
    [...kept, { type: 'user', uuid: 'u2' }].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  )
  const prepared = await runtime.prepare({ ...options, resumeSessionId: key.sessionId }, inherited)
  expect(await store.load(key)).toHaveLength(3)
  expect(database.db.prepare('SELECT * FROM sdk_transcript_backups').all()).toEqual([])
  prepared.close()
})

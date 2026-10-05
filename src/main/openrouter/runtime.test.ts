import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { sqliteSessionStore } from './transcripts'
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
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir })
  const prepared = await runtime.prepare({ ...options, taskId: task.id }, inherited)
  expect(prepared.env).toMatchObject({
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
    ANTHROPIC_AUTH_TOKEN: 'temporary-token',
    ANTHROPIC_MODEL: openRouterSdkModel(SAMPLE_CHOICE.id),
    CLAUDE_CODE_SUBAGENT_MODEL: openRouterSdkModel(SAMPLE_CHOICE.id),
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
  relay?.onGeneration?.('gen-sample', SAMPLE_CHOICE)
  expect(database.db.prepare('SELECT task_id, cost_usd FROM openrouter_generations').get()).toEqual({
    task_id: task.id,
    cost_usd: null,
  })
  const reconciled = vi.spyOn(service, 'reconcileGenerations').mockResolvedValue()
  relay?.onComplete?.()
  expect(reconciled).toHaveBeenCalled()
  prepared.close()
  expect(relayClose).toHaveBeenCalled()
})

it('allows a distinct native child only within OpenRouter and pins helper aliases to that child', async () => {
  const child = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/small@sample-host',
    model: { ...SAMPLE_MODEL, id: 'sample/small', contextLength: 64_000 },
  }
  setOpenRouterChoice(database.db, child)
  vi.spyOn(service, 'endpoints').mockResolvedValue([SAMPLE_PROVIDER])
  const prepared = await openRouterRuntime({ db: database.db, service, dataDir: dir }).prepare(
    { ...options, subagentModel: child.id },
    inherited,
  )
  expect(prepared.env).toMatchObject({
    CLAUDE_CODE_SUBAGENT_MODEL: openRouterSdkModel(child.id),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: openRouterSdkModel(child.id),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '64000',
  })
  expect(vi.mocked(createOpenRouterRelay).mock.calls.at(-1)?.[0].choices).toEqual([SAMPLE_CHOICE, child])
  vi.mocked(createOpenRouterRelay).mock.calls.at(-1)?.[0].onGeneration?.('gen-child', child)
  expect(database.db.prepare('SELECT task_id FROM openrouter_generations').get()).toEqual({ task_id: null })
  vi.spyOn(service, 'endpoints').mockImplementation((id) =>
    Promise.resolve(id === child.model.id ? [] : [SAMPLE_PROVIDER]),
  )
  await expect(
    openRouterRuntime({ db: database.db, service, dataDir: dir }).prepare(
      { ...options, subagentModel: child.id },
      inherited,
    ),
  ).rejects.toThrow('subagent provider is no longer')
})

it('keeps account configuration and login intact without passing an OpenRouter key to account agents', async () => {
  const prepared = await openRouterRuntime({ db: database.db, service, dataDir: dir }).prepare(
    { ...options, model: 'claude-sonnet-5', subagentModel: 'claude-haiku-4-5' },
    inherited,
  )
  expect(prepared.env).toMatchObject({
    CLAUDE_CONFIG_DIR: inherited.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_OAUTH_TOKEN: 'account-token',
    CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5',
  })
  expect(prepared.env.OPENROUTER_API_KEY).toBe('')
  expect(prepared.publishModels).toBe(true)
  prepared.close()
})

it('preserves legacy account file resumption when the SDK importer cannot mirror history', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir })
  vi.mocked(importSessionToStore).mockRejectedValueOnce(new Error('Old transcript format'))
  const account = await runtime.prepare({ ...options, model: 'sonnet', resumeSessionId: 'legacy' }, inherited)
  expect(account.sessionStore).toBeUndefined()
  vi.mocked(importSessionToStore).mockResolvedValueOnce()
  expect(
    (await runtime.prepare({ ...options, model: 'sonnet', resumeSessionId: 'legacy' }, inherited)).sessionStore,
  ).toBeUndefined()
  vi.mocked(importSessionToStore).mockRejectedValueOnce(new Error('Unreadable transcript'))
  await expect(runtime.prepare({ ...options, resumeSessionId: 'legacy' }, inherited)).rejects.toThrow(
    'Unreadable transcript',
  )
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
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir })
  await runtime.prepare({ ...options, resumeSessionId: 'saved-session' }, inherited)
  await runtime.prepare({ ...options, resumeSessionId: 'saved-session' }, inherited)
  expect(importSessionToStore).toHaveBeenCalledOnce()
  expect(importSessionToStore).toHaveBeenCalledWith('saved-session', expect.anything(), {
    dir: options.cwd,
    includeSubagents: true,
  })
  expect(
    await sqliteSessionStore(database.db).load({ projectKey: '-code-sample', sessionId: 'saved-session' }),
  ).toMatchObject([{ uuid: 'original' }])
  vi.mocked(importSessionToStore).mockResolvedValue()
  await expect(runtime.prepare({ ...options, resumeSessionId: 'missing-history' }, inherited)).rejects.toThrow(
    'saved SDK history',
  )
})

it('refuses missing, disabled, withdrawn-provider and missing-child routes before spawning an SDK process', async () => {
  const runtime = openRouterRuntime({ db: database.db, service, dataDir: dir })
  await expect(runtime.prepare({ ...options, model: 'openrouter:missing' }, inherited)).rejects.toThrow('Enable this')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  await expect(runtime.prepare(options, inherited)).rejects.toThrow('Enable this')
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  vi.spyOn(service, 'endpoints').mockResolvedValue([])
  await expect(runtime.prepare(options, inherited)).rejects.toThrow('provider is no longer')
  vi.spyOn(service, 'endpoints').mockResolvedValue([SAMPLE_PROVIDER])
  // The catalog may change between child validation and runtime resolution.
  const child = { ...SAMPLE_CHOICE, id: 'openrouter:sample/child@sample-host' }
  setOpenRouterChoice(database.db, child)
  vi.spyOn(service, 'endpoints').mockImplementation(() => {
    setOpenRouterChoice(database.db, { ...child, enabled: false })
    return Promise.resolve([SAMPLE_PROVIDER])
  })
  await expect(runtime.prepare({ ...options, subagentModel: child.id }, inherited)).rejects.toThrow(
    'subagent model is unavailable',
  )
})

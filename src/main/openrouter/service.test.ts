import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { getOpenRouterChoice, getOpenRouterConnection, setOpenRouterChoice } from '../db/repositories/openrouter'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { updateTask, getTask } from '../db/repositories/tasks'
import { listModels, recordSdkModels } from '../models/models'
import { OpenRouterClient } from './client'
import { OpenRouterService, type CredentialCipher } from './service'
import { SAMPLE_MODEL, SAMPLE_PROVIDER, SAMPLE_CHOICE, SAMPLE_USAGE } from '../../shared/test-openrouter'
import { getSettings, updateSettings } from '../db/repositories/settings'
import { createTask } from '../tasks/service'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { openRouterUsage } from '../db/repositories/openrouter'

let database: TestDatabase
let service: OpenRouterService
let client: OpenRouterClient
let cipher: CredentialCipher
let events: GladeEvent[]
beforeEach(() => {
  database = openTestDatabase()
  client = new OpenRouterClient(vi.fn())
  vi.spyOn(client, 'catalog').mockResolvedValue({ models: [SAMPLE_MODEL], providers: [SAMPLE_PROVIDER] })
  vi.spyOn(client, 'endpoints').mockResolvedValue([SAMPLE_PROVIDER])
  vi.spyOn(client, 'usage').mockResolvedValue(SAMPLE_USAGE)
  cipher = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((key: string) => Buffer.from(`encrypted:${key}`)),
    decryptString: vi.fn((encrypted: Buffer) => encrypted.toString().replace('encrypted:', '')),
  }
  events = []
  service = new OpenRouterService({ db: database.db, cipher, client, emit: (event) => events.push(event) })
})

it('restores a usable New task default when a default route is disabled or the key is removed', async () => {
  await service.connect('key')
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: true })
  const workspace = sampleWorkspace(database.db)
  const context = { db: database.db, emit: (event: GladeEvent) => events.push(event) }
  updateSettings(database.db, { defaultModel: SAMPLE_CHOICE.id })
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: false })
  expect(getSettings(database.db)).toMatchObject({
    defaultModel: DEFAULT_SETTINGS.defaultModel,
  })
  expect(createTask(context, workspace.id).model).toBe(DEFAULT_SETTINGS.defaultModel)
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: true })
  updateSettings(database.db, { defaultModel: SAMPLE_CHOICE.id })
  service.remove()
  expect(createTask(context, workspace.id).model).toBe(DEFAULT_SETTINGS.defaultModel)
  expect(events.some((event) => event.type === EventType.SettingsChanged)).toBe(true)
})

it('connects a management key, filters both provider lists by its guardrails and degrades without one or on failure', async () => {
  const hosts = [
    SAMPLE_PROVIDER,
    { id: 'novita', name: 'Novita' },
    { id: 'together', name: 'Together' },
    { id: 'zai', name: 'Z.ai' },
  ]
  vi.spyOn(client, 'catalog').mockResolvedValue({ models: [SAMPLE_MODEL], providers: hosts })
  await service.connect('key')
  // Without a management key, the status says so and both provider lists are the whole catalog.
  expect(service.status()).toMatchObject({
    connected: true,
    managementConnected: false,
    providers: hosts,
  })
  expect(() => service.managementKey()).toThrow(/management key/)

  // Connecting validates the key by reading the guardrails, then filters both lists to the allowed providers.
  const guardrails = vi.spyOn(client, 'guardrails').mockResolvedValue(['together', 'novita', 'together'])
  await service.connectManagementKey(' management-key ')
  expect(guardrails).toHaveBeenCalledWith('management-key')
  // Stored encrypted, like the inference key; the decrypted key never reaches the window.
  expect(getOpenRouterConnection(database.db)?.encryptedManagementKey).not.toBeNull()
  expect(service.managementKey()).toBe('management-key')
  expect(service.status()).toMatchObject({ managementConnected: true, providers: [hosts[1], hosts[2]] })
  // The per-model provider menu is filtered the same way: it only asks about the allowed hosts.
  const endpoints = vi.spyOn(client, 'endpoints').mockResolvedValue([])
  await service.endpoints(SAMPLE_MODEL.id)
  expect(endpoints).toHaveBeenCalledWith('key', SAMPLE_MODEL.id, [hosts[1], hosts[2]])

  // A refreshed guardrail reading of no restriction degrades both lists to the whole catalog.
  guardrails.mockResolvedValueOnce(null)
  await service.connectManagementKey('management-key')
  expect(service.status()).toMatchObject({ managementConnected: true, providers: hosts })

  // Removing the key clears what it read; the providers go back to the whole catalog.
  service.removeManagementKey()
  expect(service.status()).toMatchObject({ managementConnected: false, providers: hosts })
  expect(getOpenRouterConnection(database.db)?.encryptedManagementKey).toBeNull()
})

it('keeps the guardrails of a failing or absent management-key read, and re-reads at most once a minute', async () => {
  let now = 1000
  service = new OpenRouterService({
    db: database.db,
    cipher,
    client,
    emit: (event) => events.push(event),
    now: () => now,
  })
  vi.spyOn(client, 'catalog').mockResolvedValue({
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER, { id: 'novita', name: 'Novita' }],
  })
  const guardrails = vi.spyOn(client, 'guardrails')
  await service.connect('key')
  guardrails.mockResolvedValueOnce(['novita'])
  await service.connectManagementKey('management-key')
  expect(service.status().providers).toEqual([{ id: 'novita', name: 'Novita' }])
  expect(events.some((event) => event.type === EventType.ModelsChanged)).toBe(true)

  // Within a minute of the connect's read, another is put off, whatever it would say.
  await service.refreshGuardrails()
  expect(guardrails).toHaveBeenCalledTimes(1)
  expect(service.status().providers).toEqual([{ id: 'novita', name: 'Novita' }])

  // Once the minute passes, a read the API refuses changes nothing: the last known restriction stands.
  now += 60_000
  guardrails.mockRejectedValueOnce(new Error('OpenRouter returned 500'))
  await service.refreshGuardrails()
  expect(service.status().providers).toEqual([{ id: 'novita', name: 'Novita' }])

  // And a later reading of no restriction degrades the lists to the whole catalog.
  now += 60_000
  guardrails.mockResolvedValueOnce(null)
  await service.refreshGuardrails()
  expect(service.status().providers).toEqual([SAMPLE_PROVIDER, { id: 'novita', name: 'Novita' }])
  expect(events.some((event) => event.type === EventType.ModelsChanged)).toBe(true)

  // Without a management key there is nothing to read.
  service.removeManagementKey()
  guardrails.mockClear()
  await service.refreshGuardrails()
  expect(guardrails).not.toHaveBeenCalled()
})

it('refuses a management key without an inference key, secure storage, or one the API refuses', async () => {
  await expect(service.connectManagementKey('management-key')).rejects.toThrow('Connect an OpenRouter key')
  await service.connect('key')
  vi.spyOn(client, 'guardrails').mockRejectedValueOnce(new Error('OpenRouter returned 401'))
  await expect(service.connectManagementKey('bad')).rejects.toThrow('OpenRouter returned 401')
  expect(service.status().managementConnected).toBe(false)
  cipher.isEncryptionAvailable = vi.fn(() => false)
  await expect(service.connectManagementKey('management-key')).rejects.toThrow('Secure credential storage')
})

it('persists key usage, coalesces concurrent reads, throttles completions and preserves a stale reading on failure', async () => {
  let now = 1000
  service = new OpenRouterService({
    db: database.db,
    cipher,
    client,
    emit: (event) => events.push(event),
    now: () => now,
  })
  expect(await service.refreshUsage()).toEqual({ connected: false, reading: null, error: null })
  await service.connect('key')
  expect(openRouterUsage(database.db).reading).toEqual(SAMPLE_USAGE)
  const read = vi.spyOn(client, 'usage')
  await service.refreshUsage()
  expect(read).toHaveBeenCalledOnce()
  now += 60_000
  let finish: (value: typeof SAMPLE_USAGE) => void = () => undefined
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = service.refreshUsage()
  expect(service.refreshUsage(true)).toBe(pending)
  finish({ ...SAMPLE_USAGE, readAt: now })
  await pending
  read.mockRejectedValueOnce(new Error('private-key must never reach the window'))
  const failed = await service.refreshUsage(true)
  expect(failed).toMatchObject({
    reading: { ...SAMPLE_USAGE, readAt: now },
    error: expect.stringContaining('Could not refresh') as unknown,
  })
  expect(JSON.stringify(failed)).not.toContain('private-key')
  expect(service.usage()).toEqual(failed)
  await service.refresh()
  expect(service.usage()).toEqual(failed)
  expect(events.some((event) => event.type === EventType.OpenRouterUsageChanged)).toBe(true)
})

it('never restores removed/replaced account usage or touches a closed database after an in-flight read', async () => {
  await service.connect('first')
  let finish: (value: typeof SAMPLE_USAGE) => void = () => undefined
  const read = vi.spyOn(client, 'usage')
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const old = service.refreshUsage(true)
  service.remove()
  await service.connect('replacement')
  finish({ ...SAMPLE_USAGE, total: 999 })
  await old
  expect(service.usage().reading?.total).toBe(SAMPLE_USAGE.total)
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const removed = service.refreshUsage(true)
  service.remove()
  finish(SAMPLE_USAGE)
  expect(await removed).toEqual({ connected: false, reading: null, error: null })
  read.mockRejectedValueOnce(new Error('Unavailable'))
  await service.connect('again')
  expect(service.usage()).toMatchObject({ reading: null, error: expect.any(String) as unknown })
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const closed = service.refreshUsage(true)
  database.db.close()
  finish(SAMPLE_USAGE)
  expect(await closed).toEqual({ connected: false, reading: null, error: null })
})
afterEach(() => {
  service.close()
  database.close()
})

it('does not resurrect a removed key or save a route after a connection changes in flight', async () => {
  vi.spyOn(client, 'catalog').mockImplementationOnce(() => {
    service.remove()
    return Promise.resolve({ models: [SAMPLE_MODEL], providers: [SAMPLE_PROVIDER] })
  })
  await expect(service.connect('key')).rejects.toThrow('connection changed')
  await service.connect('key')
  vi.spyOn(client, 'endpoints').mockImplementationOnce(() => {
    service.remove()
    return Promise.resolve([SAMPLE_PROVIDER])
  })
  await expect(service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: true })).rejects.toThrow(
    'connection changed',
  )
  expect(service.status().choices).toEqual([])
})

it('stores only ciphertext, keeps curated pairs across key replacement and removal, and merges the picker', async () => {
  expect(service.status()).toEqual({
    connected: false,
    managementConnected: false,
    models: [],
    providers: [],
    choices: [],
  })
  expect(() => service.key()).toThrow('Connect an OpenRouter key')
  await service.connect('first')
  expect(getOpenRouterConnection(database.db)?.encryptedKey.toString()).toBe('encrypted:first')
  expect(service.key()).toBe('first')
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: true })
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  updateTask(database.db, task.id, { model: SAMPLE_CHOICE.id })
  expect(getOpenRouterChoice(database.db, SAMPLE_CHOICE.id)).toEqual(SAMPLE_CHOICE)
  expect(listModels(database.db).at(-1)).toMatchObject({ id: SAMPLE_CHOICE.id, resolvedModel: null, efforts: [] })
  recordSdkModels({ db: database.db, emit: (event) => events.push(event) }, [
    { value: 'sonnet', displayName: 'Sonnet', description: '' },
  ])
  expect(events.at(-1)).toEqual({ type: EventType.ModelsChanged, models: listModels(database.db) })
  await service.connect('replacement')
  await service.refresh()
  expect(service.key()).toBe('replacement')
  expect(JSON.stringify(service.status())).not.toContain('replacement')
  expect(service.remove()).toMatchObject({ connected: false, choices: [SAMPLE_CHOICE] })
  expect(getTask(database.db, task.id)?.modelName).toBe('Sample Flash · Sample Host')
  expect(listModels(database.db).some(({ id }) => id === SAMPLE_CHOICE.id)).toBe(false)
})

it('offers supported efforts, narrows provider filtering to key-visible models and disables an old host choice', async () => {
  vi.spyOn(client, 'catalog').mockResolvedValue({
    models: [{ ...SAMPLE_MODEL, parameters: ['tools', 'reasoning_effort'] }],
    providers: [SAMPLE_PROVIDER],
  })
  await service.connect('key')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, id: 'old', provider: { id: 'old-host', name: 'Old Host' } })
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: true })
  expect(getOpenRouterChoice(database.db, 'old')?.enabled).toBe(false)
  expect(listModels(database.db).at(-1)?.efforts).toEqual(['low', 'medium', 'high'])
  vi.spyOn(client, 'providerModels').mockResolvedValue([SAMPLE_MODEL.id, 'outside-key/catalog'])
  expect(await service.providerModels(SAMPLE_PROVIDER.id)).toEqual([SAMPLE_MODEL.id])
  await service.select({ model: SAMPLE_MODEL.id, provider: SAMPLE_PROVIDER.id, enabled: false })
  expect(listModels(database.db).some(({ id }) => id === SAMPLE_CHOICE.id)).toBe(false)
})

it('refuses unavailable encryption, credentials, models and providers without changing stored routes', async () => {
  vi.spyOn(cipher, 'isEncryptionAvailable').mockReturnValue(false)
  await expect(service.connect('key')).rejects.toThrow('Secure credential')
  vi.spyOn(cipher, 'isEncryptionAvailable').mockReturnValue(true)
  vi.spyOn(client, 'catalog').mockRejectedValueOnce(new Error('Invalid key'))
  await expect(service.connect('bad')).rejects.toThrow('Invalid key')
  expect(service.status().connected).toBe(false)
  await service.connect('key')
  await expect(service.endpoints('unknown')).rejects.toThrow('not available')
  await expect(service.select({ model: 'unknown', provider: SAMPLE_PROVIDER.id, enabled: true })).rejects.toThrow(
    'not available',
  )
  await expect(service.select({ model: SAMPLE_MODEL.id, provider: 'unknown', enabled: true })).rejects.toThrow(
    'no tool-capable',
  )
  await expect(service.providerModels('unknown')).rejects.toThrow('not in')
  vi.spyOn(client, 'catalog').mockImplementationOnce(() => {
    service.remove()
    return Promise.resolve({ models: [], providers: [] })
  })
  await expect(service.refresh()).rejects.toThrow('connection changed')
  expect(service.status().connected).toBe(false)
})

it('reads once after the last completion in a burst and cancels the trailing read on removal or shutdown', async () => {
  vi.useFakeTimers()
  try {
    await service.connect('key')
    const read = vi.spyOn(client, 'usage')
    await vi.advanceTimersByTimeAsync(10_000)
    await service.refreshUsage()
    await vi.advanceTimersByTimeAsync(20_000)
    await service.refreshUsage()
    expect(read).toHaveBeenCalledOnce()
    read.mockResolvedValue({ ...SAMPLE_USAGE, monthly: 12 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(service.usage().reading?.monthly).toBe(12)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(2)
    await service.refreshUsage(true)
    await service.refreshUsage()
    service.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

it('reports an undecryptable key without throwing at launch and keeps credit failures visible until inference succeeds', async () => {
  await service.connect('key')
  vi.spyOn(cipher, 'decryptString').mockImplementationOnce(() => {
    throw new Error('secret details')
  })
  const pending = service.refreshUsage(true)
  expect((await pending).error).toContain('Could not refresh')
  service.noteResponse(402)
  expect(service.usage().error).toContain('insufficient credits')
  await service.refreshUsage(true)
  expect(service.usage().error).toContain('insufficient credits')
  vi.spyOn(client, 'usage').mockRejectedValueOnce(new Error('Network error'))
  await service.refreshUsage(true)
  expect(service.usage().error).toContain('insufficient credits')
  service.noteResponse(500)
  expect(service.usage().error).toContain('insufficient credits')
  service.noteResponse(200)
  expect(service.usage().error).toBeNull()
  service.remove()
  service.noteResponse(402)
  expect(service.usage().error).toBeNull()
})

it('does not erase a credit failure that arrives during a failing usage read', async () => {
  await service.connect('key')
  let fail!: (reason: unknown) => void
  vi.spyOn(client, 'usage').mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  const pending = service.refreshUsage(true)
  service.noteResponse(402)
  fail(new Error('Metadata request failed'))
  await pending
  expect(service.usage().error).toContain('insufficient credits')
})

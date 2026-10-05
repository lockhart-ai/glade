import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { getOpenRouterChoice, getOpenRouterConnection, setOpenRouterChoice } from '../db/repositories/openrouter'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { updateTask, getTask } from '../db/repositories/tasks'
import { listModels, recordSdkModels } from '../models/models'
import { OpenRouterClient } from './client'
import { OpenRouterService, type CredentialCipher } from './service'
import { SAMPLE_MODEL, SAMPLE_PROVIDER, SAMPLE_CHOICE } from '../../shared/test-openrouter'

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
  cipher = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((key: string) => Buffer.from(`encrypted:${key}`)),
    decryptString: vi.fn((encrypted: Buffer) => encrypted.toString().replace('encrypted:', '')),
  }
  events = []
  service = new OpenRouterService({ db: database.db, cipher, client, emit: (event) => events.push(event) })
})
afterEach(() => {
  database.close()
})

it('keeps actual billing metadata pending until available and tolerates shutdown during discovery', async () => {
  await service.connect('key')
  service.recordGeneration({ id: 'gen-1', choiceId: SAMPLE_CHOICE.id, taskId: null })
  service.recordGeneration({ id: 'gen-1', choiceId: SAMPLE_CHOICE.id, taskId: null })
  vi.spyOn(client, 'generation')
    .mockRejectedValueOnce(new Error('Not ready'))
    .mockResolvedValueOnce({ id: 'wrong-id', total_cost: 999, provider_name: 'Wrong' })
    .mockResolvedValueOnce({ id: 'gen-1', total_cost: 0.002, provider_name: 'Actual Host' })
  await service.reconcileGenerations()
  await service.reconcileGenerations()
  expect(database.db.prepare('SELECT cost_usd FROM openrouter_generations').get()).toEqual({ cost_usd: null })
  await service.reconcileGenerations()
  expect(database.db.prepare('SELECT actual_provider, cost_usd FROM openrouter_generations').get()).toEqual({
    actual_provider: 'Actual Host',
    cost_usd: 0.002,
  })
  service.remove()
  await service.reconcileGenerations()
  database.db.close()
  service.recordGeneration({ id: 'closed', choiceId: SAMPLE_CHOICE.id, taskId: null })
  await service.reconcileGenerations()
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
  expect(service.status()).toEqual({ connected: false, models: [], providers: [], choices: [] })
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

import { afterAll, afterEach, expect, it } from 'vitest'
import { openTestDatabase, sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { setOpenRouterChoice, setOpenRouterConnection } from '../db/repositories/openrouter'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import {
  completeModelSwitch,
  pendingModelSwitch,
  stageModelSwitch,
  validateModel,
  validateSubagentModel,
} from './switches'

const database = openTestDatabase()
afterAll(() => {
  database.close()
})
afterEach(() => {
  database.db.prepare('DELETE FROM tasks').run()
  database.db.prepare('DELETE FROM workspaces').run()
  database.db.prepare('DELETE FROM openrouter_connection').run()
  database.db.prepare('DELETE FROM openrouter_choices').run()
})

it('appends exactly one immutable, timestamped timeline entry and keeps both selections', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  expect(pendingModelSwitch(database.db, task.id)).toBeNull()
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  stageModelSwitch(database.db, task.id, task.model, SAMPLE_CHOICE.id)
  expect(completeModelSwitch(database.db, task.id, 'another-model', 1)).toBeNull()
  const entry = completeModelSwitch(database.db, task.id, SAMPLE_CHOICE.id, 0)
  expect(entry).toMatchObject({ text: 'Switched model to Sample Flash · Sample Host (OpenRouter)', turn: 1 })
  expect(entry?.createdAt).toBeGreaterThan(0)
  expect(database.db.prepare('SELECT previous_model, next_model FROM model_switch_history').get()).toEqual({
    previous_model: task.model,
    next_model: SAMPLE_CHOICE.id,
  })
  expect(completeModelSwitch(database.db, task.id, SAMPLE_CHOICE.id, 1)).toBeNull()
})

it('coalesces pending changes, removes a cancelled switch, and labels account models', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  stageModelSwitch(database.db, task.id, task.model, 'claude-sonnet-5')
  stageModelSwitch(database.db, task.id, 'claude-sonnet-5', 'claude-haiku-4-5')
  expect(pendingModelSwitch(database.db, task.id)).toMatchObject({
    previous: task.model,
    label: 'Haiku 4.5 (Anthropic account)',
  })
  stageModelSwitch(database.db, task.id, 'claude-haiku-4-5', task.model)
  expect(pendingModelSwitch(database.db, task.id)).toBeNull()
})

it('only permits configured OpenRouter choices, and refuses mixed-source native children', () => {
  expect(() => {
    validateModel(database.db, 'claude-sonnet-5')
  }).not.toThrow()
  expect(() => {
    validateModel(database.db, SAMPLE_CHOICE.id)
  }).toThrow('Enable this')
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  expect(() => {
    validateModel(database.db, SAMPLE_CHOICE.id)
  }).toThrow('Enable this')
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER],
  })
  expect(() => {
    validateModel(database.db, SAMPLE_CHOICE.id)
  }).not.toThrow()
  expect(() => {
    validateSubagentModel(database.db, SAMPLE_CHOICE.id, null)
  }).not.toThrow()
  expect(() => {
    validateSubagentModel(database.db, SAMPLE_CHOICE.id, SAMPLE_CHOICE.id)
  }).not.toThrow()
  expect(() => {
    validateSubagentModel(database.db, 'claude-sonnet-5', SAMPLE_CHOICE.id)
  }).toThrow('must use the task’s source')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  expect(() => {
    validateModel(database.db, SAMPLE_CHOICE.id)
  }).toThrow('Enable this')
})

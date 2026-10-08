import { beforeEach, expect, it } from 'vitest'
import { openTestDatabase, type TestDatabase } from './test-database'
import {
  filterByGuardrails,
  getOpenRouterConnection,
  openRouterGuardrailProviders,
  openRouterStatus,
  setOpenRouterConnection,
  setOpenRouterGuardrailProviders,
  setOpenRouterManagementKey,
} from './openrouter'
import { SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../../shared/test-openrouter'

const hosts = [SAMPLE_PROVIDER, { id: 'novita', name: 'Novita' }]

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

it('stores the management key encrypted and the guardrails it read, and keeps both across a catalog refresh', () => {
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('encrypted'),
    models: [SAMPLE_MODEL],
    providers: hosts,
  })
  setOpenRouterManagementKey(database.db, Buffer.from('encrypted:management'))
  setOpenRouterGuardrailProviders(database.db, ['novita', 'together'])

  const connection = getOpenRouterConnection(database.db)
  expect(connection?.encryptedKey).toEqual(Buffer.from('encrypted'))
  expect(connection?.encryptedManagementKey).toEqual(Buffer.from('encrypted:management'))
  expect(connection?.guardrailProviders).toEqual(['novita', 'together'])
  // The status filters the providers to the ones the guardrails allow.
  expect(openRouterStatus(database.db)).toMatchObject({
    connected: true,
    managementConnected: true,
    providers: [{ id: 'novita', name: 'Novita' }],
  })

  // The catalog's periodic read rewrites the connection without touching the management key or its guardrails.
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('encrypted'),
    models: [SAMPLE_MODEL],
    providers: hosts,
  })
  const refreshed = getOpenRouterConnection(database.db)
  expect(refreshed?.encryptedManagementKey).toEqual(Buffer.from('encrypted:management'))
  expect(refreshed?.guardrailProviders).toEqual(['novita', 'together'])

  // Removing the management key removes what it read with it.
  setOpenRouterManagementKey(database.db, null)
  expect(getOpenRouterConnection(database.db)?.encryptedManagementKey).toBeNull()
  expect(openRouterGuardrailProviders(database.db)).toBeNull()
  expect(openRouterStatus(database.db)).toMatchObject({
    connected: true,
    managementConnected: false,
    providers: hosts,
  })
})

it('filters the providers to the guardrails that allow them, or none of them', () => {
  // No restriction known: the list stands.
  expect(filterByGuardrails(hosts, null)).toEqual(hosts)
  expect(filterByGuardrails(hosts, ['novita'])).toEqual([{ id: 'novita', name: 'Novita' }])
  expect(filterByGuardrails(hosts, [])).toEqual([])
})

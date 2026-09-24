import { expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, isBridgeError } from './bridge'

it('recognises a bridge error, including one copied across the context bridge', () => {
  const error = bridgeError(BridgeErrorCode.InvalidRequest, 'key: expected a UI state key')

  expect(error).toEqual({ name: 'BridgeError', code: 'invalid_request', message: 'key: expected a UI state key' })
  expect(isBridgeError(error)).toBe(true)
  expect(isBridgeError(structuredClone(error))).toBe(true)
})

it.each([
  ['undefined', undefined],
  ['null', null],
  ['an Error', new Error('boom')],
  ['an unknown code', { name: 'BridgeError', code: 'nope', message: 'x' }],
  ['a missing message', { name: 'BridgeError', code: 'internal' }],
])('does not take %s for a bridge error', (_case, value) => {
  expect(isBridgeError(value)).toBe(false)
})

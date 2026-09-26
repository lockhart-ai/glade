import { describe, expect, it } from 'vitest'
import { TaskState } from '../../../shared/domain'
import { Row, RowError } from './rows'

function row(values: Record<string, unknown>): Row {
  return new Row('things', values)
}

describe('Row', () => {
  it('rejects a value that is not a row object', () => {
    expect(() => new Row('things', undefined)).toThrow(new RowError('things', '*', 'expected a row object'))
    expect(() => new Row('things', null)).toThrow('things.*: expected a row object')
  })

  it('names the table and column of a missing column', () => {
    expect(() => row({}).text('name')).toThrow('things.name: missing')
  })

  it('reads text', () => {
    expect(row({ name: 'Acme' }).text('name')).toBe('Acme')
    expect(() => row({ name: 3 }).text('name')).toThrow('things.name: expected text, got 3')
  })

  it('reads nullable text', () => {
    expect(row({ name: null }).nullableText('name')).toBeNull()
    expect(row({ name: 'Acme' }).nullableText('name')).toBe('Acme')
    expect(() => row({ name: 1 }).nullableText('name')).toThrow('expected text')
  })

  it('reads integers', () => {
    expect(row({ count: 42 }).integer('count')).toBe(42)
    expect(() => row({ count: 1.5 }).integer('count')).toThrow('things.count: expected an integer, got 1.5')
    expect(() => row({ count: '1' }).integer('count')).toThrow('expected an integer')
    expect(() => row({ count: 2n ** 60n }).integer('count')).toThrow('expected an integer')
  })

  it('reads numbers', () => {
    expect(row({ rank: -1.25 }).real('rank')).toBe(-1.25)
    expect(() => row({ rank: Number.NaN }).real('rank')).toThrow('things.rank: expected a number, got null')
    expect(() => row({ rank: '1' }).real('rank')).toThrow('expected a number')
  })

  it('reads nullable numbers', () => {
    expect(row({ used: null }).nullableReal('used')).toBeNull()
    expect(row({ used: 0.85 }).nullableReal('used')).toBe(0.85)
    expect(() => row({ used: 'x' }).nullableReal('used')).toThrow('expected a number')
  })

  it('reads nullable integers', () => {
    expect(row({ count: null }).nullableInteger('count')).toBeNull()
    expect(row({ count: 7 }).nullableInteger('count')).toBe(7)
    expect(() => row({ count: 'x' }).nullableInteger('count')).toThrow('expected an integer')
  })

  it('reads blobs', () => {
    expect(row({ data: Buffer.from([1, 2]) }).blob('data')).toEqual(Buffer.from([1, 2]))
    expect(() => row({ data: 'AQI=' }).blob('data')).toThrow('things.data: expected a blob, got "AQI="')
  })

  it('reads 0/1 flags', () => {
    expect(row({ on: 0 }).flag('on')).toBe(false)
    expect(row({ on: 1 }).flag('on')).toBe(true)
    expect(() => row({ on: 2 }).flag('on')).toThrow('things.on: expected 0 or 1, got 2')
  })

  it('reads enum values and rejects unknown ones', () => {
    const states = Object.values(TaskState)
    expect(row({ state: 'done' }).oneOf('state', states)).toBe(TaskState.Done)
    expect(() => row({ state: 'paused' }).oneOf('state', states)).toThrow(
      'things.state: expected one of active, done, got "paused"',
    )
  })

  it('reads JSON values and objects', () => {
    expect(row({ input: '{"command":"npm test"}' }).jsonObject('input')).toEqual({ command: 'npm test' })
    expect(() => row({ input: '{' }).jsonObject('input')).toThrow('things.input: expected JSON, got "{"')
    expect(() => row({ input: '[1]' }).jsonObject('input')).toThrow('expected a JSON object, got [1]')
    expect(() => row({ input: 'null' }).jsonObject('input')).toThrow('expected a JSON object, got null')
    expect(row({ input: '[1]' }).json('input')).toEqual([1])
    expect(() => row({ input: '[' }).json('input')).toThrow('things.input: expected JSON, got "["')
  })
})

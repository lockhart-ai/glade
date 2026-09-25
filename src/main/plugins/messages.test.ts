import { describe, expect, it } from 'vitest'
import { MAX_PLUGIN_MESSAGE_BYTES, PluginMessageType } from '../../shared/plugin-api'
import { createRateLimiter, cutStatus, parsePluginMessage } from './messages'

describe('parsePluginMessage', () => {
  it('reads ready and status', () => {
    expect(parsePluginMessage({ type: 'ready' })).toEqual({ ok: true, message: { type: PluginMessageType.Ready } })
    expect(parsePluginMessage({ type: 'status', text: '5 cats' })).toEqual({
      ok: true,
      message: { type: PluginMessageType.Status, text: '5 cats' },
    })
    expect(parsePluginMessage({ type: 'status', text: '' })).toMatchObject({ ok: true })
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'ready'],
    ['a number', 42],
    ['an array', [{ type: 'ready' }]],
    ['no type', {}],
    ['an unknown type', { type: 'task.create', title: 'Delete everything' }],
    ['a status without text', { type: 'status' }],
    ['a status whose text is a number', { type: 'status', text: 42 }],
    ['a status whose text is an object', { type: 'status', text: { toString: 'x' } }],
    ['extra fields', { type: 'ready', command: 'rm -rf /' }],
    ['a status too long to be one', { type: 'status', text: 'x'.repeat(MAX_PLUGIN_MESSAGE_BYTES + 1) }],
    ['a prototype trick', JSON.parse('{"type":"ready","__proto__":{"admin":true}}') as unknown],
  ])('drops %s, saying why', (_name, raw) => {
    const parsed = parsePluginMessage(raw)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).not.toBe('')
  })
})

describe('cutStatus', () => {
  it('keeps a status of 40 characters or fewer', () => {
    expect(cutStatus('5 cats · 4 kittens')).toBe('5 cats · 4 kittens')
    expect(cutStatus('x'.repeat(40))).toBe('x'.repeat(40))
  })

  it('cuts a longer one to 40', () => {
    expect(cutStatus('x'.repeat(41))).toBe('x'.repeat(40))
    expect(cutStatus('y'.repeat(10_000))).toHaveLength(40)
  })

  it('never cuts a character in half', () => {
    const cats = '🐈'.repeat(50)

    expect(Array.from(cutStatus(cats))).toHaveLength(40)
    expect(cutStatus(cats)).toBe('🐈'.repeat(40))
  })
})

describe('createRateLimiter', () => {
  it('allows a burst, then refills at its rate, never beyond the burst', () => {
    let time = 0
    const limiter = createRateLimiter({ burst: 3, perSecond: 2 }, () => time)

    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false])
    time += 499
    expect(limiter.take()).toBe(false)
    time += 1
    expect(limiter.take()).toBe(true)
    expect(limiter.take()).toBe(false)

    time += 60_000
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false])
  })

  it('lets a flood through at the rate and no faster', () => {
    let time = 0
    const limiter = createRateLimiter({ burst: 50, perSecond: 20 }, () => time)
    let allowed = 0
    // 100,000 messages spread over ten seconds.
    for (let i = 0; i < 100_000; i += 1) {
      time = i / 10
      if (limiter.take()) allowed += 1
    }

    expect(allowed).toBeLessThanOrEqual(50 + 20 * 10)
    expect(allowed).toBeGreaterThanOrEqual(20 * 10)
  })

  it('uses the clock by default', () => {
    expect(createRateLimiter({ burst: 1, perSecond: 1 }).take()).toBe(true)
  })
})

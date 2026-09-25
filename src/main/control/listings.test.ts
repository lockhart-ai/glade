import { describe, expect, it } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { CommandFailure } from '../bridge/errors'
import { ControlError, ControlErrorCode, controlErrorFrom } from './errors'
import { createListings, LISTING_TTL_MS, MAX_LISTINGS } from './listings'

const IDS = ['a', 'b', 'c', 'd', 'e']

describe('listings', () => {
  it('fix their order on the first page, and page through it', () => {
    const listings = createListings(() => 0)
    let order = IDS
    const first = listings.page({ key: 'k', cursor: undefined, limit: 2, order: () => order })
    order = ['z']
    const second = listings.page({ key: 'k', cursor: first.nextCursor ?? '', limit: 2, order: () => order })
    const third = listings.page({ key: 'k', cursor: second.nextCursor ?? '', limit: 2, order: () => order })

    expect([first.ids, second.ids, third.ids]).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(third.nextCursor).toBeNull()
  })

  it('end on a page that fills exactly', () => {
    const listings = createListings(() => 0)

    expect(listings.page({ key: 'k', cursor: undefined, limit: 5, order: () => IDS }).nextCursor).toBeNull()
  })

  it('expire a listing not paged for a while, and refuse its cursor', () => {
    let now = 0
    const listings = createListings(() => now)
    const first = listings.page({ key: 'k', cursor: undefined, limit: 1, order: () => IDS })
    now = LISTING_TTL_MS - 1
    const second = listings.page({ key: 'k', cursor: first.nextCursor ?? '', limit: 1, order: () => IDS })
    now += LISTING_TTL_MS + 1

    expect(() => listings.page({ key: 'k', cursor: second.nextCursor ?? '', limit: 1, order: () => IDS })).toThrow(
      'cursor: it has expired',
    )
  })

  it('keep at most so many listings, forgetting the one used longest ago', () => {
    let now = 0
    const listings = createListings(() => now)
    const cursors = Array.from({ length: MAX_LISTINGS }, () => {
      now += 1
      return listings.page({ key: 'k', cursor: undefined, limit: 1, order: () => IDS }).nextCursor ?? ''
    })
    // The second is used again, so the first is the one used longest ago.
    now += 1
    const kept = listings.page({ key: 'k', cursor: cursors[1] ?? '', limit: 1, order: () => IDS })

    listings.page({ key: 'k', cursor: undefined, limit: 1, order: () => IDS })

    expect(() => listings.page({ key: 'k', cursor: cursors[0] ?? '', limit: 1, order: () => IDS })).toThrow(
      'it has expired',
    )
    expect(listings.page({ key: 'k', cursor: kept.nextCursor ?? '', limit: 1, order: () => IDS }).ids).toEqual(['c'])
  })

  it('forget expired listings when a new one starts', () => {
    let now = 0
    const listings = createListings(() => now)
    const old = listings.page({ key: 'k', cursor: undefined, limit: 1, order: () => IDS })
    now = LISTING_TTL_MS + 1
    listings.page({ key: 'k', cursor: undefined, limit: 1, order: () => IDS })
    now = 0

    expect(() => listings.page({ key: 'k', cursor: old.nextCursor ?? '', limit: 1, order: () => IDS })).toThrow(
      'it has expired',
    )
  })

  it("refuse text that isn't a cursor", () => {
    const listings = createListings()

    expect(() => listings.page({ key: 'k', cursor: '%%%', limit: 1, order: () => IDS })).toThrow(
      'cursor: not a cursor this listing gave',
    )
  })
})

describe('control errors', () => {
  it.each([
    [BridgeErrorCode.NotFound, ControlErrorCode.NotFound],
    [BridgeErrorCode.InvalidTransition, ControlErrorCode.InvalidTransition],
    [BridgeErrorCode.Busy, ControlErrorCode.InvalidTransition],
    [BridgeErrorCode.InvalidRequest, ControlErrorCode.InvalidInput],
    [BridgeErrorCode.InvalidRootPath, ControlErrorCode.InvalidInput],
    [BridgeErrorCode.OutsideWorkspace, ControlErrorCode.InvalidInput],
    [BridgeErrorCode.UnknownCommand, ControlErrorCode.Internal],
    [BridgeErrorCode.Internal, ControlErrorCode.Internal],
  ])("give a bridge command's %s as %s, with its message", (bridge, control) => {
    const error = controlErrorFrom(new CommandFailure(bridge, 'Why.'))

    expect(error.body).toEqual({ code: control, message: 'Why.' })
  })

  it('pass a control error through, and make anything else internal', () => {
    const limited = new ControlError(ControlErrorCode.RateLimited, 'Slow down.', 5)

    expect(controlErrorFrom(limited)).toBe(limited)
    expect(limited.body).toEqual({ code: 'rate_limited', message: 'Slow down.', retryAfterMs: 5 })
    expect(controlErrorFrom(new Error('Boom')).body).toEqual({ code: 'internal', message: 'Boom' })
    expect(controlErrorFrom('odd').body).toEqual({ code: 'internal', message: 'odd' })
  })
})

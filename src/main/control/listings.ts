/**
 * Paging `list_tasks` without gaps or duplicates while tasks change between pages (`docs/control-api.md`). A listing's
 * first page fixes its order: the ids of the tasks that matched then, in the order they had then. Each later page is
 * the next slice of that order, read as the tasks are now, so a task that moves (its `updatedAt` changes) is neither
 * listed twice nor skipped. A task deleted since is left out, and one created since isn't in the listing.
 *
 * The order is kept in memory, for `LISTING_TTL_MS` after its last page, and at most `MAX_LISTINGS` at a time: it's
 * a cursor, not app state. A cursor that has expired, or that's for another listing, is refused, and the caller starts
 * again.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ControlError, ControlErrorCode } from './errors'

/** How long a listing's order is kept after its last page. */
export const LISTING_TTL_MS = 10 * 60_000

/** How many listings are kept at once; the one used longest ago goes first. */
export const MAX_LISTINGS = 64

/** A page of a listing: the ids on it, and the cursor for the next, or null at the end. */
export interface ListingPage {
  readonly ids: readonly string[]
  readonly nextCursor: string | null
}

export interface ListingRequest {
  /** What the listing is of, e.g. its filters as JSON: a cursor only continues a listing of the same. */
  readonly key: string
  readonly cursor: string | undefined
  readonly limit: number
  /** Works out the listing's order, for its first page. */
  readonly order: () => readonly string[]
}

export interface Listings {
  page(request: ListingRequest): ListingPage
}

interface Listing {
  readonly key: string
  readonly ids: readonly string[]
  usedAt: number
}

const cursorSchema = z.strictObject({ listing: z.string(), offset: z.int().nonnegative() })

type Cursor = z.infer<typeof cursorSchema>

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function badCursor(why: string): ControlError {
  return new ControlError(ControlErrorCode.InvalidInput, `cursor: ${why}; list again without it`)
}

function decode(text: string): Cursor {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
  } catch {
    throw badCursor('not a cursor this listing gave')
  }
  const parsed = cursorSchema.safeParse(json)
  if (!parsed.success) throw badCursor('not a cursor this listing gave')
  return parsed.data
}

export function createListings(now: () => number = Date.now): Listings {
  const listings = new Map<string, Listing>()

  const forget = (): void => {
    const at = now()
    for (const [id, listing] of listings) if (listing.usedAt < at - LISTING_TTL_MS) listings.delete(id)
    while (listings.size >= MAX_LISTINGS) {
      const [oldest] = [...listings].sort(([, a], [, b]) => a.usedAt - b.usedAt)
      if (oldest !== undefined) listings.delete(oldest[0])
    }
  }

  return {
    page({ key, cursor, limit, order }) {
      let id: string
      let offset: number
      let listing: Listing | undefined
      if (cursor === undefined) {
        forget()
        id = randomUUID()
        offset = 0
        listing = { key, ids: order(), usedAt: now() }
        listings.set(id, listing)
      } else {
        const decoded = decode(cursor)
        id = decoded.listing
        offset = decoded.offset
        listing = listings.get(id)
        if (listing === undefined || listing.usedAt < now() - LISTING_TTL_MS) {
          listings.delete(id)
          throw badCursor('it has expired')
        }
        if (listing.key !== key) throw badCursor('it is for a listing with other filters')
        listing.usedAt = now()
      }
      const end = offset + limit
      const ids = listing.ids.slice(offset, end)
      return { ids, nextCursor: end < listing.ids.length ? encode({ listing: id, offset: end }) : null }
    },
  }
}

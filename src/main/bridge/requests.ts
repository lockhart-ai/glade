import { CommandName, type CommandRequest, type EmptyRequest } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'

/** A request that doesn't match its command's request type. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

/** Parses each command's request, which arrives from the renderer as `unknown`, into its request type. */
export type RequestParsers = { readonly [C in CommandName]: (raw: unknown) => CommandRequest<C> }

function expectObject(raw: unknown): object {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidRequestError('expected an object')
  }
  return raw
}

/** The object's own fields, refusing any it doesn't expect. */
function fields(raw: unknown, expected: readonly string[]): ReadonlyMap<string, unknown> {
  const entries = Object.entries(expectObject(raw))
  const unexpected = entries.map(([name]) => name).filter((name) => !expected.includes(name))
  if (unexpected.length > 0) throw new InvalidRequestError(`unexpected field ${unexpected.join(', ')}`)
  return new Map(entries)
}

function stringField(values: ReadonlyMap<string, unknown>, name: string): string {
  const value = values.get(name)
  if (typeof value !== 'string') throw new InvalidRequestError(`${name}: expected a string`)
  return value
}

function uiStateKeyField(values: ReadonlyMap<string, unknown>, name: string): UiStateKey {
  const value = values.get(name)
  const key = Object.values(UiStateKey).find((known) => known === value)
  if (key === undefined) throw new InvalidRequestError(`${name}: expected a UI state key`)
  return key
}

function parseEmpty(raw: unknown): EmptyRequest {
  fields(raw, [])
  return {}
}

export const REQUEST_PARSERS: RequestParsers = {
  [CommandName.WorkspacesList]: parseEmpty,
  [CommandName.UiStateGet]: (raw) => {
    const values = fields(raw, ['key'])
    return { key: uiStateKeyField(values, 'key') }
  },
  [CommandName.UiStateSet]: (raw) => {
    const values = fields(raw, ['key', 'value'])
    return { key: uiStateKeyField(values, 'key'), value: stringField(values, 'value') }
  },
}

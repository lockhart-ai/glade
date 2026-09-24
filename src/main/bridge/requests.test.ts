import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { InvalidRequestError, REQUEST_PARSERS } from './requests'

const KEY = UiStateKey.ActiveWorkspaceId

describe('REQUEST_PARSERS', () => {
  it('parses valid requests', () => {
    expect(REQUEST_PARSERS[CommandName.WorkspacesList]({})).toEqual({})
    expect(REQUEST_PARSERS[CommandName.UiStateGet]({ key: KEY })).toEqual({ key: KEY })
    expect(REQUEST_PARSERS[CommandName.UiStateSet]({ key: KEY, value: '' })).toEqual({ key: KEY, value: '' })
  })

  it.each([
    ['a missing request', CommandName.WorkspacesList, undefined, 'expected an object'],
    ['null', CommandName.UiStateGet, null, 'expected an object'],
    ['an array', CommandName.UiStateGet, [KEY], 'expected an object'],
    ['a string', CommandName.UiStateSet, 'active_workspace_id', 'expected an object'],
    ['an unexpected field', CommandName.WorkspacesList, { all: true }, 'unexpected field all'],
    ['unexpected fields', CommandName.UiStateGet, { key: KEY, a: 1, b: 2 }, 'unexpected field a, b'],
    ['a missing key', CommandName.UiStateGet, {}, 'key: expected a UI state key'],
    ['an unknown key', CommandName.UiStateSet, { key: 'theme', value: 'dark' }, 'key: expected a UI state key'],
    ['a missing value', CommandName.UiStateSet, { key: KEY }, 'value: expected a string'],
    ['a non-string value', CommandName.UiStateSet, { key: KEY, value: 3 }, 'value: expected a string'],
  ])('rejects %s', (_case, command, raw, message) => {
    const parse = REQUEST_PARSERS[command]
    expect(() => parse(raw)).toThrow(new InvalidRequestError(message))
    expect(() => parse(raw)).toThrow(InvalidRequestError)
  })
})

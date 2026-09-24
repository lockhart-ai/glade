import { expect, it } from 'vitest'
import { moduleClass } from './moduleClass'

it('returns the hashed class name', () => {
  expect(moduleClass({ button: '_button_1a2b' }, 'button')).toBe('_button_1a2b')
})

it('throws for a class the module does not define', () => {
  expect(() => moduleClass({}, 'missing')).toThrow('CSS module has no class "missing"')
})

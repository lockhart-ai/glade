import { describe, expect, it } from 'vitest'
import { PluginStatus, shownPlugin, type InstalledPlugin, type ValidPlugin } from './plugins'

function valid(folder: string, enabled = true): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: { id: folder, name: folder, version: '1.0.0', entry: 'index.html', icon: null },
    iconUrl: null,
    enabled,
  }
}

const invalid: InstalledPlugin = { status: PluginStatus.Invalid, folder: 'aaa-broken', reason: 'no manifest' }

describe('shownPlugin', () => {
  it('is none with no plugins, none on, or only invalid ones', () => {
    expect(shownPlugin([])).toBeNull()
    expect(shownPlugin([invalid, valid('nekomata', false)])).toBeNull()
  })

  it('is the only enabled plugin', () => {
    expect(shownPlugin([invalid, valid('clock', false), valid('nekomata')])?.folder).toBe('nekomata')
  })

  it('is the first enabled plugin by id, whatever order they come in', () => {
    expect(shownPlugin([valid('zen'), valid('nekomata'), valid('pomodoro')])?.folder).toBe('nekomata')
    expect(shownPlugin([valid('b'), valid('a')])?.folder).toBe('a')
    expect(shownPlugin([valid('a'), valid('b')])?.folder).toBe('a')
  })

  it("doesn't reorder the list it's given", () => {
    const plugins = [valid('b'), valid('a')]
    shownPlugin(plugins)

    expect(plugins.map(({ folder }) => folder)).toEqual(['b', 'a'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  isGranted,
  PLUGIN_CAPABILITY_LABELS,
  PluginCapability,
  PluginStatus,
  shownPlugin,
  withGrant,
  type InstalledPlugin,
  type ValidPlugin,
} from './plugins'

function valid(folder: string, enabled = true): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: { id: folder, name: folder, version: '1.0.0', entry: 'index.html', icon: null, capabilities: [] },
    iconUrl: null,
    enabled,
    granted: [],
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

describe('capabilities', () => {
  const asks: ValidPlugin = {
    ...valid('gauge'),
    manifest: { ...valid('gauge').manifest, capabilities: [PluginCapability.Machine] },
  }

  it('says what each capability lets a plugin see, as Settings shows it', () => {
    expect(PLUGIN_CAPABILITY_LABELS[PluginCapability.Machine]).toBe("Can see your Mac's CPU, GPU and Docker load")
  })

  it('withGrant turns a capability the plugin asks for on and off, and isGranted says so', () => {
    expect(isGranted(asks, PluginCapability.Machine)).toBe(false)

    const on = withGrant(asks, PluginCapability.Machine, true)
    expect(on.granted).toEqual([PluginCapability.Machine])
    expect(isGranted(on, PluginCapability.Machine)).toBe(true)
    expect(withGrant(on, PluginCapability.Machine, true).granted).toEqual([PluginCapability.Machine])

    expect(withGrant(on, PluginCapability.Machine, false).granted).toEqual([])
    expect(asks.granted).toEqual([])
  })

  it("withGrant can't turn on a capability the plugin doesn't ask for", () => {
    expect(withGrant(valid('pomodoro'), PluginCapability.Machine, true).granted).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  isGranted,
  isPluginSettingType,
  offersSetting,
  PLUGIN_CAPABILITY_LABELS,
  PluginCapability,
  PluginSettingType,
  PluginStatus,
  settingValues,
  shownPlugin,
  withGrant,
  withSetting,
  type InstalledPlugin,
  type PluginSetting,
  type ValidPlugin,
} from './plugins'

function valid(folder: string, enabled = true): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: {
      id: folder,
      name: folder,
      version: '1.0.0',
      entry: 'index.html',
      icon: null,
      capabilities: [],
      settings: [],
    },
    iconUrl: null,
    enabled,
    granted: [],
    settings: {},
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

describe('settings', () => {
  const STYLE: PluginSetting = {
    type: PluginSettingType.Select,
    key: 'style',
    label: 'Art style',
    options: [
      { value: 'ink', label: 'Ink' },
      { value: 'chalk', label: 'Chalk' },
    ],
    default: 'ink',
  }
  const PACE: PluginSetting = {
    type: PluginSettingType.Select,
    key: 'pace',
    label: 'Pace',
    options: [
      { value: 'slow', label: 'Slow' },
      { value: 'fast', label: 'Fast' },
    ],
    default: 'fast',
  }
  const sketchpad: ValidPlugin = {
    ...valid('sketchpad'),
    manifest: { ...valid('sketchpad').manifest, settings: [STYLE, PACE] },
    settings: { style: 'ink', pace: 'fast' },
  }

  it('knows the select type, and no other', () => {
    expect(isPluginSettingType('select')).toBe(true)
    expect(isPluginSettingType('toggle')).toBe(false)
    expect(isPluginSettingType('Select')).toBe(false)
  })

  it('settingValues gives every declared setting its default when nothing is saved', () => {
    expect(settingValues([STYLE, PACE], undefined)).toEqual({ style: 'ink', pace: 'fast' })
    expect(settingValues([STYLE, PACE], new Map())).toEqual({ style: 'ink', pace: 'fast' })
    expect(settingValues([], new Map([['style', 'chalk']]))).toEqual({})
  })

  it('settingValues gives the saved value, and leaves out what the plugin does not declare', () => {
    const saved = new Map([
      ['style', 'chalk'],
      ['volume', 'loud'],
    ])
    expect(settingValues([STYLE, PACE], saved)).toEqual({ style: 'chalk', pace: 'fast' })
  })

  it('settingValues falls back to the default for a saved value no longer among the options', () => {
    const saved = new Map([
      ['style', 'oil'],
      ['pace', 'slow'],
    ])
    expect(settingValues([STYLE, PACE], saved)).toEqual({ style: 'ink', pace: 'slow' })
    // A value another setting offers isn't one this setting does.
    expect(settingValues([STYLE], new Map([['style', 'slow']]))).toEqual({ style: 'ink' })
  })

  it('offersSetting is true only for a setting the plugin declares and a value it offers', () => {
    expect(offersSetting(sketchpad, 'style', 'chalk')).toBe(true)
    expect(offersSetting(sketchpad, 'style', 'slow')).toBe(false)
    expect(offersSetting(sketchpad, 'volume', 'chalk')).toBe(false)
    expect(offersSetting(valid('pomodoro'), 'style', 'chalk')).toBe(false)
  })

  it('withSetting sets one setting and leaves the others, and the plugin it was given, alone', () => {
    const chalk = withSetting(sketchpad, 'style', 'chalk')

    expect(chalk.settings).toEqual({ style: 'chalk', pace: 'fast' })
    expect(sketchpad.settings).toEqual({ style: 'ink', pace: 'fast' })
  })

  it("withSetting can't set a setting the plugin doesn't declare, or to a value it doesn't offer", () => {
    expect(withSetting(sketchpad, 'style', 'oil')).toBe(sketchpad)
    expect(withSetting(sketchpad, 'volume', 'loud')).toBe(sketchpad)
    expect(withSetting(valid('pomodoro'), 'style', 'chalk').settings).toEqual({})
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

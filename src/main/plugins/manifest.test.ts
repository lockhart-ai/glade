import { describe, expect, it } from 'vitest'
import {
  MAX_PLUGIN_SETTING_OPTIONS,
  MAX_PLUGIN_SETTINGS,
  PluginCapability,
  PluginSettingType,
} from '../../shared/plugins'
import { isInsidePath, knownCapabilities, parsePluginManifest, PLUGIN_ID } from './manifest'

const VALID = { id: 'pomodoro', name: 'Pomodoro', version: '0.4.2', entry: 'index.html', icon: 'icon.svg' }
/** What `VALID` parses to: it asks for no capabilities and declares no settings. */
const PARSED = { ...VALID, capabilities: [], settings: [] }

/** The reason a manifest with `fields` over the valid one is refused, or null when it's valid. */
function reasonFor(fields: Record<string, unknown>): string | null {
  const parsed = parsePluginManifest(JSON.stringify({ ...VALID, ...fields }))
  return parsed.ok ? null : parsed.reason
}

describe('parsePluginManifest', () => {
  it('parses a valid manifest, with its icon', () => {
    expect(parsePluginManifest(JSON.stringify(VALID))).toEqual({ ok: true, manifest: PARSED })
  })

  it('reads a manifest without an icon as having none', () => {
    const withoutIcon = { id: VALID.id, name: VALID.name, version: VALID.version, entry: VALID.entry }
    expect(parsePluginManifest(JSON.stringify(withoutIcon))).toEqual({ ok: true, manifest: { ...PARSED, icon: null } })
  })

  it('ignores unknown fields, and drops them', () => {
    const parsed = parsePluginManifest(JSON.stringify({ ...VALID, author: 'Acme', permissions: ['network'] }))
    expect(parsed).toEqual({ ok: true, manifest: PARSED })
  })

  it('trims the name', () => {
    expect(parsePluginManifest(JSON.stringify({ ...VALID, name: '  Pomodoro ' }))).toEqual({
      ok: true,
      manifest: PARSED,
    })
  })

  it("says why a manifest isn't JSON", () => {
    expect(parsePluginManifest('{ "id": "pomodoro", ')).toEqual({
      ok: false,
      reason: expect.stringMatching(/^manifest\.json isn't valid JSON: /) as unknown,
    })
    expect(parsePluginManifest('')).toMatchObject({ ok: false })
  })

  it.each([['[]'], ['null'], ['"pomodoro"'], ['42']])('refuses %s, which is not an object', (text) => {
    expect(parsePluginManifest(text)).toEqual({
      ok: false,
      reason: expect.stringMatching(/^manifest\.json: /) as unknown,
    })
  })

  it('names every missing field', () => {
    const parsed = parsePluginManifest('{}')
    expect(parsed.ok).toBe(false)
    const reason = parsed.ok ? '' : parsed.reason
    for (const field of ['id', 'name', 'version', 'entry']) expect(reason).toContain(`${field}: `)
    expect(reason).not.toContain('icon')
  })

  it.each([
    ['Pomodoro', 'uppercase'],
    ['-pomodoro', 'a leading dash'],
    ['pomo doro', 'a space'],
    ['pomodoro_timer', 'an underscore'],
    ['', 'nothing'],
    ['a'.repeat(65), '65 characters'],
    [42, 'a number'],
  ])('refuses the id %j (%s)', (id, why) => {
    expect(reasonFor({ id }), why).toMatch(/^id: /)
  })

  it('takes an id of 64 characters, or one starting with a digit', () => {
    expect(reasonFor({ id: 'a'.repeat(64) })).toBeNull()
    expect(reasonFor({ id: '2048-clock' })).toBeNull()
  })

  it.each([[''], ['   '], ['x'.repeat(41)], [null]])('refuses the name %j', (name) => {
    expect(reasonFor({ name })).toMatch(/^name: /)
  })

  it.each([['1'], ['1.2'], ['v1.2.0'], ['1.2.0.3'], ['01.2.0'], ['latest']])('refuses the version %j', (version) => {
    expect(reasonFor({ version })).toMatch(/^version: Expected a semver version/)
  })

  it.each([['1.2.0'], ['0.0.1'], ['1.2.0-beta.1'], ['1.2.0+42'], ['10.20.30-rc.1+build.5']])(
    'takes the version %j',
    (version) => {
      expect(reasonFor({ version })).toBeNull()
    },
  )

  it.each([
    ['../index.html', 'outside the folder, up'],
    ['pages/../../index.html', 'outside the folder, through a subfolder'],
    ['/Users/sample/index.html', 'absolute'],
    ['\\index.html', 'absolute, Windows-style'],
    ['..\\index.html', 'outside the folder, Windows-style'],
    ['~/index.html', 'in the home folder'],
    ['', 'nothing'],
  ])('refuses the entry %j (%s)', (entry) => {
    expect(reasonFor({ entry })).toMatch(/^entry: Expected a path inside the plugin's folder/)
  })

  it('refuses an entry that is not an .html file', () => {
    expect(reasonFor({ entry: 'index.js' })).toBe('entry: Expected an .html file')
    expect(reasonFor({ entry: 'index.htm' })).toBe('entry: Expected an .html file')
  })

  it('takes an entry in a subfolder, or with an uppercase extension', () => {
    expect(reasonFor({ entry: 'dist/index.html' })).toBeNull()
    expect(reasonFor({ entry: './INDEX.HTML' })).toBeNull()
  })

  it('refuses an icon outside the folder, or not an .svg or .png', () => {
    expect(reasonFor({ icon: '../icon.svg' })).toBe("icon: Expected a path inside the plugin's folder")
    expect(reasonFor({ icon: '/tmp/icon.png' })).toBe("icon: Expected a path inside the plugin's folder")
    expect(reasonFor({ icon: 'icon.jpg' })).toBe('icon: Expected an .svg or .png file')
    expect(reasonFor({ icon: null })).toMatch(/^icon: /)
  })

  it('takes a .png icon', () => {
    expect(reasonFor({ icon: 'assets/icon.png' })).toBeNull()
  })

  it('names every problem at once', () => {
    expect(reasonFor({ id: 'Bad', entry: '../x.html' })).toBe(
      "id: Expected lowercase letters, digits and -, up to 64 characters; entry: Expected a path inside the plugin's folder",
    )
  })
})

describe('capabilities', () => {
  it('reads the machine capability a manifest asks for', () => {
    expect(parsePluginManifest(JSON.stringify({ ...VALID, capabilities: ['machine'] }))).toEqual({
      ok: true,
      manifest: { ...PARSED, capabilities: [PluginCapability.Machine] },
    })
  })

  it("reads none from an empty list, or from a manifest that doesn't list any", () => {
    expect(parsePluginManifest(JSON.stringify({ ...VALID, capabilities: [] }))).toEqual({ ok: true, manifest: PARSED })
    expect(parsePluginManifest(JSON.stringify(VALID))).toEqual({ ok: true, manifest: PARSED })
  })

  it("drops capabilities this Glade doesn't know, and repeats, rather than refusing the plugin", () => {
    const parsed = parsePluginManifest(
      JSON.stringify({ ...VALID, capabilities: ['camera', 'machine', 'Machine', 'machine', 'network'] }),
    )
    expect(parsed).toEqual({ ok: true, manifest: { ...PARSED, capabilities: [PluginCapability.Machine] } })
  })

  it.each([
    ['a string', 'machine'],
    ['an object', { machine: true }],
    ['a list with a number in it', ['machine', 3]],
    ['null', null],
  ])('refuses capabilities that are %s, saying what it expected', (_name, capabilities) => {
    expect(reasonFor({ capabilities })).toMatch(/^capabilities(\.\d+)?: /)
  })

  it('knownCapabilities keeps the known ones once each, in the order listed', () => {
    expect(knownCapabilities([])).toEqual([])
    expect(knownCapabilities(['x', 'machine', 'machine'])).toEqual([PluginCapability.Machine])
  })
})

describe('settings', () => {
  const STYLE = {
    key: 'style',
    label: 'Art style',
    type: 'select',
    options: [
      { value: 'ink', label: 'Ink' },
      { value: 'chalk', label: 'Chalk' },
      { value: 'neon-2', label: 'Neon' },
    ],
    default: 'ink',
  }

  /** The settings a manifest listing `settings` comes to; throws when it's refused. */
  function settingsOf(settings: unknown): unknown {
    const parsed = parsePluginManifest(JSON.stringify({ ...VALID, settings }))
    if (!parsed.ok) throw new Error(parsed.reason)
    return parsed.manifest.settings
  }

  it('reads a select setting: its key, label, options in order and default', () => {
    expect(settingsOf([STYLE])).toEqual([{ ...STYLE, type: PluginSettingType.Select }])
  })

  it('reads none from an empty list, or from a manifest without any', () => {
    expect(settingsOf([])).toEqual([])
    expect(parsePluginManifest(JSON.stringify(VALID))).toEqual({ ok: true, manifest: PARSED })
  })

  it('keeps several in the order listed, trims labels, and drops fields it does not know', () => {
    const pace = {
      key: 'pace',
      label: '  Pace ',
      type: 'select',
      options: [{ value: 'slow', label: ' Slow ', hint: 'x' }],
      default: 'slow',
      help: 'How fast it draws',
    }
    expect(settingsOf([pace, STYLE])).toEqual([
      { key: 'pace', label: 'Pace', type: 'select', options: [{ value: 'slow', label: 'Slow' }], default: 'slow' },
      STYLE,
    ])
  })

  it("ignores a setting of a type this Glade doesn't know, whatever else it holds, and keeps the rest", () => {
    const toggle = { key: 'sound', label: 'Sound', type: 'toggle', default: true }
    const bare = { key: 'later', type: 'colour' }

    expect(settingsOf([toggle, STYLE, bare])).toEqual([STYLE])
    expect(settingsOf([toggle])).toEqual([])
  })

  it('takes as many settings and options as the caps allow, and a label as long as a name', () => {
    const options = Array.from({ length: MAX_PLUGIN_SETTING_OPTIONS }, (_, index) => ({
      value: `v${String(index)}`,
      label: 'x'.repeat(40),
    }))
    const settings = Array.from({ length: MAX_PLUGIN_SETTINGS }, (_, index) => ({
      key: `k${String(index)}`,
      label: 'x'.repeat(40),
      type: 'select',
      options,
      default: 'v11',
    }))

    expect(settingsOf(settings)).toHaveLength(8)
  })

  it.each([
    ['duplicate keys', [STYLE, { ...STYLE, label: 'Again' }], 'settings.1.key: Duplicate key style'],
    [
      "a key repeated by a setting of a type this Glade doesn't know",
      [STYLE, { key: 'style', type: 'toggle' }],
      'settings.1.key: Duplicate key style',
    ],
    [
      'a default not among the options',
      [{ ...STYLE, default: 'oil' }],
      'settings.0.default: Expected one of the option values',
    ],
    ['no default', [{ ...STYLE, default: undefined }], 'settings.0.default: Expected one of the option values'],
    [
      'too many settings',
      Array.from({ length: 9 }, (_, index) => ({ ...STYLE, key: `style-${String(index)}` })),
      'settings: Expected at most 8 settings',
    ],
    [
      'too many unknown settings',
      Array.from({ length: 9 }, (_, index) => ({ key: `k${String(index)}`, type: 'toggle' })),
      'settings: Expected at most 8 settings',
    ],
    [
      'too many options',
      [{ ...STYLE, options: Array.from({ length: 13 }, (_, i) => ({ value: `v${String(i)}`, label: 'V' })) }],
      'settings.0.options: Expected at most 12 options',
    ],
    ['no options', [{ ...STYLE, options: [] }], 'settings.0.options: Expected at least one option'],
    ['options that are not a list', [{ ...STYLE, options: 'ink' }], 'settings.0.options: Expected a list of'],
    [
      'the same value twice',
      [{ ...STYLE, options: [...STYLE.options, { value: 'ink', label: 'Ink again' }] }],
      'settings.0.options.3.value: Duplicate value ink',
    ],
    ['a key with other characters', [{ ...STYLE, key: 'Art_Style' }], 'settings.0.key: Expected lowercase letters'],
    [
      'an option value with other characters',
      [{ ...STYLE, options: [{ value: '8 bit', label: '8-bit' }], default: '8 bit' }],
      'settings.0.options.0.value: Expected lowercase letters',
    ],
    ['a blank label', [{ ...STYLE, label: '   ' }], 'settings.0.label: Expected a label that is not blank'],
    ['a label over 40 characters', [{ ...STYLE, label: 'x'.repeat(41) }], 'settings.0.label: Expected at most 40'],
    [
      'an option label over 40 characters',
      [{ ...STYLE, options: [{ value: 'ink', label: 'x'.repeat(41) }] }],
      'settings.0.options.0.label: Expected at most 40',
    ],
    ['no type', [{ key: 'style', label: 'Art style' }], 'settings.0.type: Expected a setting type'],
    ['no key', [{ type: 'toggle' }], 'settings.0.key: '],
    ['an entry that is not an object', ['style'], 'settings.0: '],
    ['settings that are not a list', { style: STYLE }, 'settings: Expected a list of settings'],
    ['null', null, 'settings: Expected a list of settings'],
  ])('refuses %s, saying where and why', (_name, settings, reason) => {
    expect(reasonFor({ settings })).toContain(reason)
  })
})

describe('isInsidePath', () => {
  it('takes relative paths that stay inside, and nothing else', () => {
    expect(isInsidePath('index.html')).toBe(true)
    expect(isInsidePath('a/b/c.html')).toBe(true)
    expect(isInsidePath('..index.html')).toBe(true)
    expect(isInsidePath('a/../b.html')).toBe(false)
    expect(isInsidePath('..')).toBe(false)
    expect(isInsidePath('/etc/hosts')).toBe(false)
  })
})

describe('PLUGIN_ID', () => {
  it('matches the ids the plugin API allows', () => {
    expect(PLUGIN_ID.test('nekomata')).toBe(true)
    expect(PLUGIN_ID.test('cat-cafe-2')).toBe(true)
    expect(PLUGIN_ID.test('Cat')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isInsidePath, parsePluginManifest, PLUGIN_ID } from './manifest'

const VALID = { id: 'pomodoro', name: 'Pomodoro', version: '0.4.2', entry: 'index.html', icon: 'icon.svg' }

/** The reason a manifest with `fields` over the valid one is refused, or null when it's valid. */
function reasonFor(fields: Record<string, unknown>): string | null {
  const parsed = parsePluginManifest(JSON.stringify({ ...VALID, ...fields }))
  return parsed.ok ? null : parsed.reason
}

describe('parsePluginManifest', () => {
  it('parses a valid manifest, with its icon', () => {
    expect(parsePluginManifest(JSON.stringify(VALID))).toEqual({ ok: true, manifest: VALID })
  })

  it('reads a manifest without an icon as having none', () => {
    const withoutIcon = { id: VALID.id, name: VALID.name, version: VALID.version, entry: VALID.entry }
    expect(parsePluginManifest(JSON.stringify(withoutIcon))).toEqual({ ok: true, manifest: { ...VALID, icon: null } })
  })

  it('ignores unknown fields, and drops them', () => {
    const parsed = parsePluginManifest(JSON.stringify({ ...VALID, author: 'Acme', permissions: ['network'] }))
    expect(parsed).toEqual({ ok: true, manifest: VALID })
  })

  it('trims the name', () => {
    expect(parsePluginManifest(JSON.stringify({ ...VALID, name: '  Pomodoro ' }))).toEqual({
      ok: true,
      manifest: VALID,
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

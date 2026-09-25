import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PLUGIN_ICON_BYTES, MAX_PLUGIN_MANIFEST_BYTES, PluginStatus } from '../../shared/plugins'
import { findPlugins, type FoundPlugin } from './discovery'
import { SAMPLE_PNG, SAMPLE_SVG, sampleManifest, tempPluginsParent, writePlugin } from './test-plugins'

let parent: string
let plugins: string

beforeEach(() => {
  parent = tempPluginsParent()
  plugins = join(parent, 'plugins')
  mkdirSync(plugins)
})

afterEach(() => {
  chmodSync(parent, 0o755)
  rmSync(parent, { recursive: true, force: true })
})

/** What was found, as each folder and its reason, or `valid`. */
function summary(found: readonly FoundPlugin[]): [string, string][] {
  return found.map((plugin) => [plugin.folder, plugin.status === PluginStatus.Valid ? 'valid' : plugin.reason])
}

/** The reason the only plugin found is invalid. */
async function onlyReason(): Promise<string> {
  const [plugin, ...rest] = await findPlugins(plugins)
  expect(rest).toEqual([])
  if (plugin?.status !== PluginStatus.Invalid)
    throw new Error(`expected one invalid plugin, got ${JSON.stringify(plugin)}`)
  return plugin.reason
}

describe('findPlugins', () => {
  it('creates the plugins folder when it is missing, and finds nothing in it', async () => {
    const missing = join(parent, 'not-yet', 'plugins')

    expect(await findPlugins(missing)).toEqual([])
    expect(await findPlugins(missing)).toEqual([])
  })

  it('finds nothing in an empty folder', async () => {
    expect(await findPlugins(plugins)).toEqual([])
  })

  it('finds a valid plugin, with its manifest and its icon as a data URL', async () => {
    writePlugin(plugins, 'pomodoro')

    expect(await findPlugins(plugins)).toEqual([
      {
        status: PluginStatus.Valid,
        folder: 'pomodoro',
        manifest: {
          id: 'pomodoro',
          name: 'Pomodoro',
          version: '0.4.2',
          entry: 'index.html',
          icon: 'icon.svg',
        },
        iconUrl: `data:image/svg+xml;base64,${Buffer.from(SAMPLE_SVG).toString('base64')}`,
      },
    ])
  })

  it('finds a plugin without an icon, and one with a PNG icon', async () => {
    const noIcon = { ...sampleManifest('no-icon'), icon: undefined }
    writePlugin(plugins, 'no-icon', noIcon)
    writePlugin(
      plugins,
      'png-icon',
      { ...sampleManifest('png-icon'), icon: 'assets/icon.png' },
      {
        'index.html': '<!doctype html>',
        'assets/icon.png': SAMPLE_PNG,
      },
    )

    const found = await findPlugins(plugins)

    expect(found).toMatchObject([
      { folder: 'no-icon', status: PluginStatus.Valid, iconUrl: null, manifest: { icon: null } },
      {
        folder: 'png-icon',
        status: PluginStatus.Valid,
        iconUrl: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}`,
      },
    ])
  })

  it('finds two plugins, in order of folder name', async () => {
    writePlugin(plugins, 'zen-clock')
    writePlugin(plugins, 'abacus')

    expect(summary(await findPlugins(plugins))).toEqual([
      ['abacus', 'valid'],
      ['zen-clock', 'valid'],
    ])
  })

  it('ignores unknown fields in a manifest', async () => {
    writePlugin(plugins, 'pomodoro', { ...sampleManifest(), homepage: 'https://example.com', permissions: ['all'] })

    const [plugin] = await findPlugins(plugins)
    expect(plugin).toMatchObject({ status: PluginStatus.Valid })
    expect(plugin?.status === PluginStatus.Valid && Object.keys(plugin.manifest)).toEqual([
      'id',
      'name',
      'version',
      'entry',
      'icon',
    ])
  })

  it('lists a folder without a manifest as invalid', async () => {
    writePlugin(plugins, 'pomodoro', null)

    expect(await onlyReason()).toBe('No manifest.json')
  })

  it('lists a manifest that is not JSON as invalid, with the parse error', async () => {
    writePlugin(plugins, 'pomodoro', '{ "id": "pomodoro",')

    expect(await onlyReason()).toMatch(/^manifest\.json isn't valid JSON: /)
  })

  it("lists a manifest that doesn't fit the schema as invalid, with each problem", async () => {
    writePlugin(plugins, 'pomodoro', { id: 'pomodoro', name: '', version: 'one' })

    expect(await onlyReason()).toBe(
      'name: Expected a name that is not blank; version: Expected a semver version, like 1.2.0; entry: Invalid input: expected string, received undefined',
    )
  })

  it("lists a plugin whose id doesn't match its folder as invalid", async () => {
    writePlugin(plugins, 'pomodoro-copy', sampleManifest('pomodoro'))

    expect(await onlyReason()).toBe('id: "pomodoro" doesn\'t match its folder\'s name, "pomodoro-copy"')
  })

  it("lists a folder whose name can't be an id as invalid", async () => {
    writePlugin(plugins, 'Pomodoro', sampleManifest('pomodoro'))

    expect(await onlyReason()).toBe('id: "pomodoro" doesn\'t match its folder\'s name, "Pomodoro"')
  })

  it('keeps one of two plugins claiming the same id: the one whose folder has that name', async () => {
    writePlugin(plugins, 'pomodoro')
    writePlugin(plugins, 'pomodoro-2', sampleManifest('pomodoro'))

    expect(summary(await findPlugins(plugins))).toEqual([
      ['pomodoro', 'valid'],
      ['pomodoro-2', 'id: "pomodoro" doesn\'t match its folder\'s name, "pomodoro-2"'],
    ])
  })

  it('lists an entry outside the folder as invalid: with .., and absolute', async () => {
    writePlugin(plugins, 'up', { ...sampleManifest('up'), entry: '../x.html' })
    writePlugin(plugins, 'absolute', { ...sampleManifest('absolute'), entry: join(parent, 'x.html') })
    writeFileSync(join(plugins, 'x.html'), '<!doctype html>')

    expect(summary(await findPlugins(plugins))).toEqual([
      ['absolute', "entry: Expected a path inside the plugin's folder"],
      ['up', "entry: Expected a path inside the plugin's folder"],
    ])
  })

  it('lists an entry that a symlink takes outside the folder as invalid', async () => {
    const outside = join(parent, 'outside.html')
    writeFileSync(outside, '<!doctype html>')
    const dir = writePlugin(plugins, 'pomodoro', sampleManifest(), { 'icon.svg': SAMPLE_SVG })
    symlinkSync(outside, join(dir, 'index.html'))

    expect(await onlyReason()).toBe("entry: index.html is a symlink to outside the plugin's folder")
  })

  it('lists an entry in a subfolder that is a symlink to outside as invalid', async () => {
    mkdirSync(join(parent, 'elsewhere'))
    writeFileSync(join(parent, 'elsewhere', 'index.html'), '<!doctype html>')
    const dir = writePlugin(
      plugins,
      'pomodoro',
      { ...sampleManifest(), entry: 'dist/index.html' },
      {
        'icon.svg': SAMPLE_SVG,
      },
    )
    symlinkSync(join(parent, 'elsewhere'), join(dir, 'dist'))

    expect(await onlyReason()).toBe("entry: dist/index.html is a symlink to outside the plugin's folder")
  })

  it('takes an entry that is a symlink to another file inside the folder', async () => {
    const dir = writePlugin(plugins, 'pomodoro', sampleManifest(), {
      'dist/page.html': '<!doctype html>',
      'icon.svg': SAMPLE_SVG,
    })
    symlinkSync(join(dir, 'dist', 'page.html'), join(dir, 'index.html'))

    expect(summary(await findPlugins(plugins))).toEqual([['pomodoro', 'valid']])
  })

  it('lists a missing entry file as invalid', async () => {
    writePlugin(plugins, 'pomodoro', sampleManifest(), { 'icon.svg': SAMPLE_SVG })

    expect(await onlyReason()).toBe("entry: index.html doesn't exist")
  })

  it('lists an entry under a file as invalid, as missing', async () => {
    writePlugin(plugins, 'pomodoro', { ...sampleManifest(), entry: 'icon.svg/index.html' })

    expect(await onlyReason()).toBe("entry: icon.svg/index.html doesn't exist")
  })

  it('lists an entry that is a folder as invalid', async () => {
    const dir = writePlugin(plugins, 'pomodoro', sampleManifest(), { 'icon.svg': SAMPLE_SVG })
    mkdirSync(join(dir, 'index.html'))

    expect(await onlyReason()).toBe("entry: index.html isn't a file")
  })

  it('lists an icon outside the folder as invalid: with .., absolute, and through a symlink', async () => {
    const outside = join(parent, 'icon.svg')
    writeFileSync(outside, SAMPLE_SVG)
    writePlugin(plugins, 'up', { ...sampleManifest('up'), icon: '../icon.svg' })
    writePlugin(plugins, 'absolute', { ...sampleManifest('absolute'), icon: outside })
    const linked = writePlugin(plugins, 'linked', sampleManifest('linked'), { 'index.html': '<!doctype html>' })
    symlinkSync(outside, join(linked, 'icon.svg'))

    expect(summary(await findPlugins(plugins))).toEqual([
      ['absolute', "icon: Expected a path inside the plugin's folder"],
      ['linked', "icon: icon.svg is a symlink to outside the plugin's folder"],
      ['up', "icon: Expected a path inside the plugin's folder"],
    ])
  })

  it('lists a missing icon, a PNG that is not one, and an icon too large as invalid', async () => {
    writePlugin(plugins, 'missing', sampleManifest('missing'), { 'index.html': '<!doctype html>' })
    writePlugin(
      plugins,
      'not-png',
      { ...sampleManifest('not-png'), icon: 'icon.png' },
      {
        'index.html': '<!doctype html>',
        'icon.png': SAMPLE_SVG,
      },
    )
    writePlugin(plugins, 'too-large', sampleManifest('too-large'), {
      'index.html': '<!doctype html>',
      'icon.svg': ' '.repeat(MAX_PLUGIN_ICON_BYTES + 1),
    })

    expect(summary(await findPlugins(plugins))).toEqual([
      ['missing', "icon: icon.svg doesn't exist"],
      ['not-png', "icon: icon.png isn't a PNG"],
      ['too-large', 'icon: icon.svg is larger than 256 KB'],
    ])
  })

  it('lists a manifest too large to read as invalid', async () => {
    writePlugin(
      plugins,
      'pomodoro',
      JSON.stringify({ ...sampleManifest(), padding: 'x'.repeat(MAX_PLUGIN_MANIFEST_BYTES) }),
    )

    expect(await onlyReason()).toBe('manifest.json is larger than 64 KB')
  })

  it('lists a manifest that is a symlink to outside the folder, or a folder, as invalid', async () => {
    const outside = join(parent, 'manifest.json')
    writeFileSync(outside, JSON.stringify(sampleManifest('linked')))
    const linked = writePlugin(plugins, 'linked', null)
    symlinkSync(outside, join(linked, 'manifest.json'))
    const folder = writePlugin(plugins, 'folder', null)
    mkdirSync(join(folder, 'manifest.json'))

    expect(summary(await findPlugins(plugins))).toEqual([
      ['folder', "manifest.json: manifest.json isn't a file"],
      ['linked', "manifest.json: manifest.json is a symlink to outside the plugin's folder"],
    ])
  })

  it("lists a plugin whose files can't be read as invalid, with why", async () => {
    const dir = writePlugin(plugins, 'locked', sampleManifest('locked'))
    // Its folder can be listed but not entered, so its manifest can't be resolved.
    chmodSync(dir, 0o600)

    try {
      expect(await onlyReason()).toMatch(/^manifest\.json: manifest\.json can't be read \(EACCES\)$/)
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it("lists a plugin whose manifest can't be read as invalid, and the rest as usual", async () => {
    const dir = writePlugin(plugins, 'unreadable', sampleManifest('unreadable'))
    writePlugin(plugins, 'pomodoro')
    chmodSync(join(dir, 'manifest.json'), 0o000)

    try {
      expect(summary(await findPlugins(plugins))).toEqual([
        ['pomodoro', 'valid'],
        ['unreadable', expect.stringMatching(/^It can't be read: EACCES/) as unknown as string],
      ])
    } finally {
      chmodSync(join(dir, 'manifest.json'), 0o644)
    }
  })

  it('skips files, hidden entries and symlinks to nothing in the plugins folder', async () => {
    writeFileSync(join(plugins, '.DS_Store'), '')
    writeFileSync(join(plugins, 'README.txt'), 'Plugins go here')
    writePlugin(plugins, '.hidden')
    symlinkSync(join(parent, 'gone'), join(plugins, 'dangling'))
    writePlugin(plugins, 'pomodoro')

    expect(summary(await findPlugins(plugins))).toEqual([['pomodoro', 'valid']])
  })

  it('takes a plugin folder that is a symlink to a folder elsewhere, with its files inside that folder', async () => {
    writePlugin(parent, 'pomodoro')
    symlinkSync(join(parent, 'pomodoro'), join(plugins, 'pomodoro'))

    expect(summary(await findPlugins(plugins))).toEqual([['pomodoro', 'valid']])
  })

  it('throws when the plugins folder is a file', async () => {
    const file = join(parent, 'file')
    writeFileSync(file, '')

    await expect(findPlugins(file)).rejects.toThrow()
  })

  it('finds a plugin gone once its folder is removed, and back once it returns', async () => {
    const dir = writePlugin(plugins, 'pomodoro')
    expect(summary(await findPlugins(plugins))).toEqual([['pomodoro', 'valid']])

    rmSync(dir, { recursive: true })
    expect(await findPlugins(plugins)).toEqual([])

    writePlugin(plugins, 'pomodoro')
    expect(summary(await findPlugins(plugins))).toEqual([['pomodoro', 'valid']])
  })
})

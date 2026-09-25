import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLog } from '../logging/memory-sink'
import { createPluginFileHandler, mediaTypeOf, PLUGIN_CSP, resolvePluginFile } from './protocol'
import { tempPluginsParent, writePlugin } from './test-plugins'

let parent: string
let folder: string

beforeEach(() => {
  parent = tempPluginsParent()
  folder = writePlugin(join(parent, 'plugins'), 'pomodoro', undefined, {
    'index.html': '<!doctype html><title>Pomodoro</title>',
    'app/main.js': 'window.glade.post({ type: "ready" })',
    'app/style.css': 'body { margin: 0 }',
    'icon.svg': '<svg/>',
    'odd name #1.txt': 'odd',
  })
  // What a plugin must never read: Glade's own data beside the plugins folder, and another plugin.
  writeFileSync(join(parent, 'glade.db'), 'SECRET DATABASE')
  writePlugin(join(parent, 'plugins'), 'other', undefined, { 'index.html': 'OTHER PLUGIN' })
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('resolvePluginFile', () => {
  it('finds a file in the folder, however deep', async () => {
    expect(await resolvePluginFile(folder, '/index.html')).toMatch(/pomodoro\/index\.html$/)
    expect(await resolvePluginFile(folder, '/app/main.js')).toMatch(/pomodoro\/app\/main\.js$/)
    expect(await resolvePluginFile(folder, '/odd%20name%20%231.txt')).toMatch(/odd name #1\.txt$/)
  })

  it.each([
    ['..', '/../../glade.db'],
    ['.. in the middle', '/app/../../../glade.db'],
    ['encoded dots', '/%2e%2e/%2e%2e/glade.db'],
    ['encoded slashes', '/..%2F..%2Fglade.db'],
    ['another plugin', '/../other/index.html'],
    ['an absolute path', '//etc/passwd'],
    ['an encoded absolute path', '/%2Fetc%2Fpasswd'],
    ['a backslash', '/..\\..\\glade.db'],
    ['an encoded backslash', '/..%5C..%5Cglade.db'],
    ['a NUL', '/index.html%00.png'],
    ['bad encoding', '/%E0%A4%A'],
    ['a missing file', '/nope.html'],
    ['the folder itself', '/'],
    ['a folder in it', '/app'],
  ])('refuses %s', async (_name, path) => {
    expect(await resolvePluginFile(folder, path)).toBeNull()
  })

  it('refuses a symlink that points out of the folder', async () => {
    symlinkSync(join(parent, 'glade.db'), join(folder, 'escape.txt'))
    symlinkSync(parent, join(folder, 'up'))

    expect(await resolvePluginFile(folder, '/escape.txt')).toBeNull()
    expect(await resolvePluginFile(folder, '/up/glade.db')).toBeNull()
  })

  it('follows a symlink that stays in the folder', async () => {
    symlinkSync(join(folder, 'index.html'), join(folder, 'home.html'))

    expect(await resolvePluginFile(folder, '/home.html')).toMatch(/pomodoro\/index\.html$/)
  })

  it('refuses everything when the folder is gone', async () => {
    rmSync(folder, { recursive: true })

    expect(await resolvePluginFile(folder, '/index.html')).toBeNull()
  })

  it('reads a file whose name starts with two dots', async () => {
    writeFileSync(join(folder, '..notes.txt'), 'notes')

    expect(await resolvePluginFile(folder, '/..notes.txt')).toMatch(/\.\.notes\.txt$/)
  })
})

describe('createPluginFileHandler', () => {
  const handler = () => createPluginFileHandler({ id: 'pomodoro', folder })

  it('serves a file with its type, the CSP and nosniff', async () => {
    const response = await handler()(new Request('glade-plugin://pomodoro/app/main.js'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('window.glade.post({ type: "ready" })')
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toBe(PLUGIN_CSP)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('answers HEAD without a body', async () => {
    const response = await handler()(new Request('glade-plugin://pomodoro/index.html', { method: 'HEAD' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('')
  })

  it("refuses another plugin's host, and logs it", async () => {
    const log = createMemoryLog()
    const response = await createPluginFileHandler({ id: 'pomodoro', folder, log: log.logger })(
      new Request('glade-plugin://other/index.html'),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
    expect(response.headers.get('Content-Security-Policy')).toBe(PLUGIN_CSP)
    expect(log.records).toEqual([expect.objectContaining({ message: 'plugin asked for another host' })])
  })

  it.each(['POST', 'PUT', 'DELETE'])('refuses %s', async (method) => {
    const response = await handler()(new Request('glade-plugin://pomodoro/index.html', { method, body: 'x' }))

    expect(response.status).toBe(405)
  })

  it.each(['/%2e%2e/%2e%2e/glade.db', '/..%2F..%2Fglade.db', '/..%2Fother%2Findex.html', '/missing.js'])(
    'answers %s with a 404 and logs it, never the file',
    async (path) => {
      const log = createMemoryLog()
      const response = await createPluginFileHandler({ id: 'pomodoro', folder, log: log.logger })(
        new Request(`glade-plugin://pomodoro${path}`),
      )

      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
      expect(log.records).toEqual([expect.objectContaining({ message: 'plugin file refused' })])
    },
  )

  it('never answers with a file outside the folder, whatever the URL parser makes of the path', async () => {
    const response = await handler()(new Request('glade-plugin://pomodoro/../../glade.db'))

    expect(await response.text()).not.toContain('SECRET')
  })
})

describe('mediaTypeOf', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['STYLE.CSS', 'text/css; charset=utf-8'],
    ['cat.png', 'image/png'],
    ['icon.svg', 'image/svg+xml'],
    ['font.woff2', 'font/woff2'],
    ['data.bin', 'application/octet-stream'],
    ['Makefile', 'application/octet-stream'],
  ])('serves %s as %s', (file, type) => {
    expect(mediaTypeOf(file)).toBe(type)
  })
})

describe('PLUGIN_CSP', () => {
  it('is the policy in docs/plugin-api.md', () => {
    expect(PLUGIN_CSP).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; " +
        "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; " +
        "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    )
  })

  it('never allows eval or a remote host', () => {
    expect(PLUGIN_CSP).not.toContain('unsafe-eval')
    expect(PLUGIN_CSP).not.toContain('https:')
    expect(PLUGIN_CSP).not.toMatch(/(^|\s)\*(\s|;|$)/)
  })
})

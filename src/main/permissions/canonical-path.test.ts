// One spelling for a path (#448): what the sandbox's folder checks compare, so a link, an alias, another case or `~`
// can't stand in for a folder they deny.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { absolutePath, canonicalKey, keyInside, NATIVE_FS, pathKey, type PathFs } from './canonical-path'

/** A file system of the paths given: `real` maps each path that exists to where it really is, `links` each link. */
function fakeFs(real: Readonly<Record<string, string>>, links: Readonly<Record<string, string>> = {}): PathFs {
  return {
    realpath: (path) => real[path] ?? null,
    readlink: (path) => links[path] ?? null,
  }
}

/** Counts what a resolution reads. */
function counting(fs: PathFs): PathFs & { readonly reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    realpath(path) {
      reads.push(`realpath ${path}`)
      return fs.realpath(path)
    },
    readlink(path) {
      reads.push(`readlink ${path}`)
      return fs.readlink(path)
    },
  }
}

describe('pathKey', () => {
  it('ignores case, Unicode form and the data volume’s prefix', () => {
    expect(pathKey('/Users/Me/Documents')).toBe('/users/me/documents')
    // "é" as one code point, and as "e" with a combining accent.
    expect(pathKey('/Users/me/café')).toBe(pathKey('/Users/me/café'))
    expect(pathKey('/System/Volumes/Data/Users/me/.ssh')).toBe('/users/me/.ssh')
    expect(pathKey('/system/volumes/data/Users/me')).toBe('/users/me')
    expect(pathKey('/System/Volumes/Data')).toBe('/')
    expect(pathKey('/System/Volumes/Database/x')).toBe('/system/volumes/database/x')
    expect(pathKey('/System/Volumes/Preboot')).toBe('/system/volumes/preboot')
  })
})

describe('absolutePath', () => {
  const ROOT = '/Users/me/src/acme-api'
  const HOME = '/Users/me'

  it('takes `~` for the home folder, and a relative path from the root', () => {
    expect(absolutePath('~', ROOT, HOME)).toBe('/Users/me')
    expect(absolutePath('~/Documents/taxes.pdf', ROOT, HOME)).toBe('/Users/me/Documents/taxes.pdf')
    expect(absolutePath('src/retry.ts', ROOT, HOME)).toBe('/Users/me/src/acme-api/src/retry.ts')
    expect(absolutePath('../other/.env', ROOT, HOME)).toBe('/Users/me/src/other/.env')
    expect(absolutePath('/etc/../etc/hosts', ROOT, HOME)).toBe('/etc/hosts')
    // Only `~` alone and `~/…` are the home folder: another user's `~name` is a name like any other.
    expect(absolutePath('~other/notes', ROOT, HOME)).toBe('/Users/me/src/acme-api/~other/notes')
  })
})

describe('canonicalKey', () => {
  it('is where the path really is, when it exists', () => {
    const fs = fakeFs({ '/Users/me/src/acme-api/link/taxes.pdf': '/Users/me/Documents/taxes.pdf' })
    expect(canonicalKey('/Users/me/src/acme-api/link/taxes.pdf', fs)).toBe('/users/me/documents/taxes.pdf')
  })

  it('resolves the deepest folder that exists, and keeps the rest as written', () => {
    const fs = fakeFs({ '/Users/me/src/acme-api/link': '/Users/me/Documents', '/': '/' })
    expect(canonicalKey('/Users/me/src/acme-api/link/new/File.txt', fs)).toBe('/users/me/documents/new/file.txt')
    expect(canonicalKey('/Nowhere/At/All', fs)).toBe('/nowhere/at/all')
  })

  it('reads each path once, from the path itself up to the first that exists', () => {
    const fs = counting(fakeFs({ '/tmp': '/private/tmp' }))
    expect(canonicalKey('/tmp/claude/h/x', fs)).toBe('/private/tmp/claude/h/x')
    expect(fs.reads).toEqual([
      'realpath /tmp/claude/h/x',
      'readlink /tmp/claude/h/x',
      'realpath /tmp/claude/h',
      'readlink /tmp/claude/h',
      'realpath /tmp/claude',
      'readlink /tmp/claude',
      'realpath /tmp',
    ])
    expect(new Set(fs.reads).size).toBe(fs.reads.length)
  })

  it('follows a link to somewhere that doesn’t exist yet: a write through it lands there', () => {
    const fs = fakeFs(
      { '/Users/me': '/Users/me' },
      { '/Users/me/src/acme-api/out': '../../Library/LaunchAgents', '/Users/me/src/acme-api/abs': '/Volumes/New' },
    )
    expect(canonicalKey('/Users/me/src/acme-api/out/x.plist', fs)).toBe('/users/me/library/launchagents/x.plist')
    expect(canonicalKey('/Users/me/src/acme-api/abs', fs)).toBe('/volumes/new')
  })

  it('drops the data volume’s prefix from where a path leads, too', () => {
    const fs = fakeFs({ '/Users/me/src/acme-api/d': '/System/Volumes/Data/Users/me/.ssh' })
    expect(canonicalKey('/Users/me/src/acme-api/d', fs)).toBe('/users/me/.ssh')
    expect(canonicalKey('/System/Volumes/Data/Users/me/.ssh/id_rsa', fakeFs({}))).toBe('/users/me/.ssh/id_rsa')
  })

  it('gives up on a loop of links', () => {
    const fs = fakeFs({}, { '/a': '/b', '/b': '/a' })
    expect(canonicalKey('/a/x', fs)).toBeNull()
  })

  it('keeps a path as written when nothing of it exists, not even the root', () => {
    expect(canonicalKey('/Users/Me/x', fakeFs({}))).toBe('/users/me/x')
    expect(canonicalKey('/', fakeFs({}))).toBe('/')
  })
})

describe('keyInside', () => {
  it('is the folder or something in it, never a folder whose name only starts the same', () => {
    expect(keyInside('/users/me/notes', '/users/me/notes')).toBe(true)
    expect(keyInside('/users/me/notes/a.md', '/users/me/notes')).toBe(true)
    expect(keyInside('/users/me/notes-old/a.md', '/users/me/notes')).toBe(false)
    expect(keyInside('/etc/hosts', '/')).toBe(true)
  })
})

describe('the real file system', () => {
  let folder: string

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-paths-')))
    mkdirSync(join(folder, 'root'))
    mkdirSync(join(folder, 'private'))
    writeFileSync(join(folder, 'private', 'taxes.txt'), 'sample')
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('follows a link a command made in the root to the folder it leads to', () => {
    symlinkSync(join(folder, 'private'), join(folder, 'root', 'link'))
    const inside = pathKey(join(folder, 'private'))

    expect(canonicalKey(join(folder, 'root', 'link', 'taxes.txt'))).toBe(`${inside}/taxes.txt`)
    expect(canonicalKey(join(folder, 'root', 'link', 'new.txt'))).toBe(`${inside}/new.txt`)
    expect(keyInside(canonicalKey(join(folder, 'root', 'link', 'new.txt')) ?? '', pathKey(join(folder, 'root')))).toBe(
      false,
    )
  })

  it('follows a link whose target isn’t there yet', () => {
    symlinkSync(join(folder, 'private', 'later'), join(folder, 'root', 'dangling'))

    expect(canonicalKey(join(folder, 'root', 'dangling'))).toBe(pathKey(join(folder, 'private', 'later')))
    expect(canonicalKey(join(folder, 'root', 'dangling', 'x.txt'))).toBe(
      pathKey(join(folder, 'private', 'later', 'x.txt')),
    )
  })

  it('reads a real path, and nothing for one that isn’t there or isn’t a link', () => {
    expect(NATIVE_FS.realpath(join(folder, 'root'))).toBe(join(folder, 'root'))
    expect(NATIVE_FS.realpath(join(folder, 'missing'))).toBeNull()
    expect(NATIVE_FS.readlink(join(folder, 'root'))).toBeNull()
    expect(canonicalKey(join(folder, 'root', 'a', 'b.txt'))).toBe(pathKey(join(folder, 'root', 'a', 'b.txt')))
  })
})

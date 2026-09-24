import { describe, expect, it } from 'vitest'
import {
  fileName,
  isWorkspaceRelativePath,
  noOpenFiles,
  normalizePath,
  withClosedFile,
  withOpenedFile,
  workspaceRelativePath,
} from './files'

describe('normalizePath', () => {
  it('resolves . and .., and drops repeated and trailing slashes', () => {
    expect(normalizePath('/code/acme-api/./docs//rate-limits.md')).toBe('/code/acme-api/docs/rate-limits.md')
    expect(normalizePath('/code/acme-api/src/../docs/')).toBe('/code/acme-api/docs')
    expect(normalizePath('/../etc')).toBe('/etc')
    expect(normalizePath('docs/../../secrets')).toBe('../secrets')
    expect(normalizePath('../../x')).toBe('../../x')
    expect(normalizePath('/')).toBe('/')
  })
})

describe('workspaceRelativePath', () => {
  it('makes an absolute path inside the root, or one relative to it, relative to the root', () => {
    expect(workspaceRelativePath('/code/acme-api/docs/rate-limits.md', '/code/acme-api')).toBe('docs/rate-limits.md')
    expect(workspaceRelativePath('/code/acme-api/docs/rate-limits.md', '/code/acme-api/')).toBe('docs/rate-limits.md')
    expect(workspaceRelativePath('src/./date.ts', '/code/acme-api')).toBe('src/date.ts')
    expect(workspaceRelativePath('/etc/hosts', '/')).toBe('etc/hosts')
  })

  it('is null outside the root, or for the root itself', () => {
    expect(workspaceRelativePath('/code/acme-api-old/README.md', '/code/acme-api')).toBeNull()
    expect(workspaceRelativePath('../secrets/token.txt', '/code/acme-api')).toBeNull()
    expect(workspaceRelativePath('/code/acme-api/src/../../x', '/code/acme-api')).toBeNull()
    expect(workspaceRelativePath('/code/acme-api', '/code/acme-api')).toBeNull()
  })
})

describe('isWorkspaceRelativePath', () => {
  it('holds for a normalized path inside the root', () => {
    expect(isWorkspaceRelativePath('docs/rate-limits.md')).toBe(true)
    expect(isWorkspaceRelativePath('..notes.md')).toBe(true)
  })

  it('refuses an absolute, climbing, unnormalized or empty path', () => {
    for (const path of ['', '/etc/hosts', '..', '../secrets', 'docs/../README.md', './README.md', 'docs/']) {
      expect(isWorkspaceRelativePath(path), path).toBe(false)
    }
  })
})

describe('open files', () => {
  const none = noOpenFiles('t1')

  it('open a file as a new tab at the end, or show its tab', () => {
    const one = withOpenedFile(none, 'docs/rate-limits.md')
    const two = withOpenedFile(one, 'api/throttles.py')

    expect(two).toEqual({
      taskId: 't1',
      paths: ['docs/rate-limits.md', 'api/throttles.py'],
      activePath: 'api/throttles.py',
    })
    expect(withOpenedFile(two, 'docs/rate-limits.md')).toEqual({ ...two, activePath: 'docs/rate-limits.md' })
  })

  it('close a tab, showing the next one, or the one before when it was last', () => {
    const three = { taskId: 't1', paths: ['a.md', 'b.md', 'c.md'], activePath: 'b.md' }

    expect(withClosedFile(three, 'b.md')).toEqual({ ...three, paths: ['a.md', 'c.md'], activePath: 'c.md' })
    expect(withClosedFile({ ...three, activePath: 'c.md' }, 'c.md').activePath).toBe('b.md')
    expect(withClosedFile(three, 'a.md')).toEqual({ ...three, paths: ['b.md', 'c.md'] })
    expect(withClosedFile(withOpenedFile(none, 'a.md'), 'a.md')).toEqual(none)
    expect(withClosedFile(three, 'gone.md')).toBe(three)
  })
})

describe('fileName', () => {
  it('is the last part of a path', () => {
    expect(fileName('docs/rate-limits.md')).toBe('rate-limits.md')
    expect(fileName('README.md')).toBe('README.md')
  })
})

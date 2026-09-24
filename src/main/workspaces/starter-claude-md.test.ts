import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedClaudeMd, STARTER_CLAUDE_MD } from './starter-claude-md'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'glade-seed-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('STARTER_CLAUDE_MD', () => {
  it('describes the task-folder convention', () => {
    expect(STARTER_CLAUDE_MD).toContain('`tasks/<task-id>-<slug>/`')
    expect(STARTER_CLAUDE_MD).toContain('git worktree')
  })
})

describe('seedClaudeMd', () => {
  it('writes the starter CLAUDE.md, and nothing else, into a root that has none', () => {
    expect(seedClaudeMd(root)).toBe(true)

    expect(readdirSync(root)).toEqual(['CLAUDE.md'])
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(STARTER_CLAUDE_MD)
  })

  it('leaves an existing CLAUDE.md exactly as it is', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# My conventions\n')

    expect(seedClaudeMd(root)).toBe(false)

    expect(readdirSync(root)).toEqual(['CLAUDE.md'])
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# My conventions\n')
  })

  it('leaves alone anything else already named CLAUDE.md', () => {
    mkdirSync(join(root, 'CLAUDE.md'))

    expect(seedClaudeMd(root)).toBe(false)
    expect(readdirSync(join(root, 'CLAUDE.md'))).toEqual([])
  })

  it('throws when the root cannot be written to', () => {
    expect(() => seedClaudeMd(join(root, 'missing'))).toThrow(/ENOENT/)
  })
})

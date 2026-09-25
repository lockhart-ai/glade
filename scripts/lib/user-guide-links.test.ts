// Every relative link and image in the user guide (docs/user-guide.md) resolves: files and images exist, and anchors
// name a heading of the guide.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const GUIDE = resolve(__dirname, '..', '..', 'docs', 'user-guide.md')

/**
 * Files other open PRs add, which the guide links to already: the docs index comes with D-03 (#242). Each is let off
 * only while it's missing; once it exists, its links are checked like any other. Remove an entry when its PR lands.
 */
const PENDING = new Set(['docs/README.md'])

const text = readFileSync(GUIDE, 'utf8')
// Code blocks and inline code hold examples, not links.
const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

/** Every link and image target: `[text](target)` and `![alt](target)`, without an optional title. */
const targets = [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? '')

/** A heading's anchor, as GitHub makes it: lower case, punctuation dropped, spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

const anchors = new Set(
  [...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug((match[1] ?? '').replace(/\*/g, ''))),
)

const external = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target)
const local = targets.filter((target) => !external(target))

describe('the user guide', () => {
  it('has links to check', () => {
    expect(local.length).toBeGreaterThan(20)
    expect(local.filter((target) => target.startsWith('images/')).length).toBeGreaterThan(0)
  })

  it.each(local.filter((target) => !target.startsWith('#')))('links to a file that exists: %s', (target) => {
    const [path = ''] = target.split('#')
    const file = join(dirname(GUIDE), decodeURIComponent(path))
    const fromRepo = join('docs', decodeURIComponent(path)).replace(/\\/g, '/')
    if (PENDING.has(fromRepo) && !existsSync(file)) return
    expect(existsSync(file), `${target} (${file})`).toBe(true)
  })

  it.each(local.filter((target) => target.startsWith('#')))('links to a heading of its own: %s', (target) => {
    expect(anchors.has(target.slice(1)), target).toBe(true)
  })

  it('names images that are small', () => {
    for (const target of local.filter((image) => image.startsWith('images/'))) {
      const bytes = readFileSync(join(dirname(GUIDE), target)).byteLength
      expect(bytes, target).toBeLessThanOrEqual(300_000)
    }
  })
})

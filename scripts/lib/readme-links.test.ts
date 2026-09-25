// Checks the root README's links: every relative link and image points at a file in the repo, every #anchor at one of
// its headings, and every image is small enough to commit (CLAUDE.md asks for small binaries).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(__dirname, '..', '..')
const README = resolve(REPO, 'README.md')

/**
 * Docs the README links to that other issues add (D-02 #241 writes the user guide; D-03 #242 the docs index and
 * llms.txt). Allowed to be missing until they land; once each is on main, its entry can go, and the check then holds
 * it to existing like any other link.
 */
const PENDING = new Set(['docs/user-guide.md', 'docs/README.md', 'llms.txt'])

/** The most an image in the README may weigh, in bytes (about 300 KB). */
const MAX_IMAGE_BYTES = 300 * 1024

/** A Markdown link or image in the README. */
interface Link {
  readonly image: boolean
  readonly target: string
}

/** The README's text with fenced code blocks and inline code removed, so their brackets aren't read as links. */
function prose(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '')
}

/** Every inline `[text](target)` and `![alt](target)` in `markdown`. */
function linksIn(markdown: string): Link[] {
  return [...prose(markdown).matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => ({
    image: match[1] === '!',
    target: match[2] ?? '',
  }))
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

/** The anchors of every heading in `markdown`. */
function anchorsIn(markdown: string): Set<string> {
  return new Set([...prose(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1] ?? '')))
}

const isExternal = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target)

describe('README links', () => {
  const markdown = readFileSync(README, 'utf8')
  const links = linksIn(markdown)
  const local = links.filter((link) => !isExternal(link.target) && !link.target.startsWith('#'))

  it('finds the links and images', () => {
    expect(local.length).toBeGreaterThan(10)
    expect(local.filter((link) => link.image).length).toBeGreaterThanOrEqual(5)
  })

  it('points every relative link and image at a file or folder in the repo', () => {
    const missing = local
      .map((link) => decodeURIComponent(link.target.split('#')[0] ?? ''))
      .filter((path) => !PENDING.has(path) && !existsSync(resolve(dirname(README), path)))
    expect(missing).toEqual([])
  })

  it('points every #anchor at a heading', () => {
    const anchors = anchorsIn(markdown)
    const broken = links
      .filter((link) => link.target.startsWith('#'))
      .map((link) => link.target.slice(1))
      .filter((anchor) => !anchors.has(anchor))
    expect(broken).toEqual([])
  })

  it('keeps every image small', () => {
    const heavy = local
      .filter((link) => link.image)
      .map((link) => resolve(dirname(README), link.target))
      .filter((path) => statSync(path).size > MAX_IMAGE_BYTES)
    expect(heavy).toEqual([])
  })
})

describe('slug', () => {
  it('makes anchors the way GitHub does', () => {
    expect(slug('For AI agents')).toBe('for-ai-agents')
    expect(slug('Settings › Control')).toBe('settings--control')
  })
})

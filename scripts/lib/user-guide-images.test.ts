// The user guide's screenshots (docs/images/guide/) stay small. That every link and image in the guide resolves is
// doc-links.test.ts's job.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DOCS = resolve(__dirname, '..', '..', 'docs')
const IMAGES = join(DOCS, 'images', 'guide')

/** The most a screenshot may weigh: a 256-colour PNG of the window comes to about half this. */
const MAX_BYTES = 300_000

const images = readdirSync(IMAGES).filter((name) => name.endsWith('.png'))
const guide = readFileSync(join(DOCS, 'user-guide.md'), 'utf8')

describe('the user guide’s screenshots', () => {
  it('are there', () => {
    expect(images.length).toBeGreaterThan(0)
  })

  it.each(images)('%s is at most 300 KB, and the guide shows it', (name) => {
    expect(statSync(join(IMAGES, name)).size).toBeLessThanOrEqual(MAX_BYTES)
    expect(guide).toContain(`](images/guide/${name})`)
  })
})

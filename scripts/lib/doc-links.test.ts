import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anchorsOf, brokenLinks, extractLinks, GITHUB_BLOB, markdownFiles, slugOf } from './doc-links.mjs'

const REPO = resolve(__dirname, '..', '..')

/**
 * The most an image in docs/images/ (the README's and the user guide's) may weigh: about 300 KB. CLAUDE.md asks for
 * small binaries; a 256-colour PNG of the window comes to about half this.
 */
const MAX_IMAGE_BYTES = 300 * 1024

describe('the links in the docs', () => {
  // Every Markdown file at the root and under docs/, release notes included (their links are few and all resolve),
  // and llms.txt, whose links are to this repo on GitHub.
  const files = [...markdownFiles(REPO, ''), ...markdownFiles(REPO, 'docs'), 'llms.txt']

  it('checks the root docs, docs/ and llms.txt', () => {
    expect(files).toEqual(
      expect.arrayContaining(['README.md', 'CLAUDE.md', 'docs/README.md', 'docs/control-api.md', 'llms.txt']),
    )
    expect(files).toEqual(expect.arrayContaining(['docs/design/README.md', 'docs/releases/v0.12.0.md']))
  })

  it('all resolve', () => {
    expect(brokenLinks({ root: REPO, files })).toEqual([])
  })
})

describe('the images in docs/images/', () => {
  const folder = join(REPO, 'docs', 'images')
  const images = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((path) =>
    /\.(png|webp|gif|jpe?g)$/.test(path),
  )
  const docs = [...markdownFiles(REPO, ''), ...markdownFiles(REPO, 'docs')]
    .map((path) => readFileSync(join(REPO, path), 'utf8'))
    .join('\n')

  it('include the README’s and the user guide’s', () => {
    expect(images).toEqual(expect.arrayContaining(['hero.png', expect.stringMatching(/^guide\//)]))
  })

  it.each(images)('%s is at most 300 KB, and a doc shows it', (path) => {
    expect(statSync(join(folder, path)).size).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(docs).toContain(`images/${path})`)
  })
})

describe('extractLinks', () => {
  it('finds links, images and HTML src and href, with their lines', () => {
    const markdown = [
      '# Title',
      'See [the API](control-api.md#tools) and ![a screen](design/screens/01-new-task.png "New task").',
      '<img src="images/hero.png" alt=""> <a href="https://example.com">x</a> [angle](<b.md>)',
    ].join('\n')
    expect(extractLinks(markdown)).toEqual([
      { target: 'control-api.md#tools', line: 2 },
      { target: 'design/screens/01-new-task.png', line: 2 },
      { target: 'b.md', line: 3 },
      { target: 'images/hero.png', line: 3 },
      { target: 'https://example.com', line: 3 },
    ])
  })

  it('skips links in code blocks and inline code', () => {
    const markdown = ['```md', '[not](a-link.md)', '```', 'Nor `[this](one.md)`, but [this](real.md).'].join('\n')
    expect(extractLinks(markdown)).toEqual([{ target: 'real.md', line: 4 }])
  })
})

describe('anchorsOf', () => {
  it('makes GitHub’s anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered', () => {
    const markdown = [
      '## Calls, results and errors',
      '### `list_tasks`',
      '## Settings › Control',
      '## Notes',
      '## Notes',
      '## [Linked](x.md) heading ##',
      '```',
      '# not a heading',
      '```',
    ].join('\n')
    expect([...anchorsOf(markdown)]).toEqual([
      'calls-results-and-errors',
      'list_tasks',
      'settings--control',
      'notes',
      'notes-1',
      'linked-heading',
    ])
  })

  it('keeps letters and digits of any script', () => {
    expect(slugOf(' Café 2 ')).toBe('café-2')
  })
})

describe('brokenLinks', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-links-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(path: string, text = ''): void {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  it('passes links that resolve: relative, root-relative, to a folder, to a heading, to itself, external', () => {
    write('docs/guide.md', '# Guide\n\n## Getting started\n')
    write('docs/images/shot.png')
    write(
      'docs/README.md',
      [
        '[guide](guide.md) [start](guide.md#getting-started) [shot](images/shot.png) [images](images)',
        '[root](/docs/guide.md) [top](#index) [web](https://example.com) [mail](mailto:a@example.com)',
        '# Index',
      ].join('\n'),
    )
    expect(brokenLinks({ root, files: ['docs/README.md'] })).toEqual([])
  })

  it('reports a missing file, a missing heading and a link out of the repo', () => {
    write('docs/guide.md', '# Guide\n')
    write('docs/README.md', '[a](gone.md)\n[b](guide.md#nope)\n[c](../../outside.md)\n[d](#nowhere)')
    expect(brokenLinks({ root, files: ['docs/README.md'] })).toEqual([
      { file: 'docs/README.md', line: 1, target: 'gone.md', reason: 'no such file' },
      { file: 'docs/README.md', line: 2, target: 'guide.md#nope', reason: 'no heading #nope' },
      { file: 'docs/README.md', line: 3, target: '../../outside.md', reason: 'it points outside the repo' },
      { file: 'docs/README.md', line: 4, target: '#nowhere', reason: 'no heading #nowhere' },
    ])
  })

  it('checks links to this repo on GitHub against the files, and decodes escaped paths', () => {
    write('docs/control-api.md', '# Control API\n\n## Turning it on\n')
    write('docs/a file.md')
    write(
      'llms.txt',
      [
        `- [Control API](${GITHUB_BLOB}docs/control-api.md#turning-it-on)`,
        `- [Missing](${GITHUB_BLOB}docs/missing.md)`,
        `- [Spaced](${GITHUB_BLOB}docs/a%20file.md)`,
        '- [Elsewhere](https://github.com/lockhart-ai/nekomata)',
      ].join('\n'),
    )
    expect(brokenLinks({ root, files: ['llms.txt'] })).toEqual([
      { file: 'llms.txt', line: 2, target: `${GITHUB_BLOB}docs/missing.md`, reason: 'no such file' },
    ])
  })
})

describe('markdownFiles', () => {
  it('lists a folder’s Markdown files and its subfolders’, sorted, skipping the ones asked; at the root, only its own', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-links-'))
    try {
      for (const path of ['README.md', 'notes.txt', 'docs/b.md', 'docs/a.md', 'docs/design/c.md', 'docs/old/d.md']) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), '')
      }
      expect(markdownFiles(root, '')).toEqual(['README.md'])
      expect(markdownFiles(root, 'docs', ['docs/old'])).toEqual(['docs/a.md', 'docs/b.md', 'docs/design/c.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

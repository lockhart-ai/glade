import { describe, expect, it } from 'vitest'
import { humanize, mediaBody, parseMediaName, recordingsMarkdown, screenshotsMarkdown } from './media-body.mjs'

/** A recording renderer like publish-media.mjs's: the GIF inline, and an MP4 link for names in `withMp4`. */
function recordingOf(withMp4: readonly string[] = []) {
  return (name: string): string[] => [
    `![${name}](https://example.com/${name}.gif)`,
    ...(withMp4.includes(name) ? [`[MP4](https://example.com/${name}.mp4)`] : []),
  ]
}

const urlFor = (file: string): string => `https://example.com/${file}`

describe('parseMediaName', () => {
  it('reads a before/after token as a prefix', () => {
    expect(parseMediaName('before-login')).toEqual({ role: 'before', what: 'login' })
    expect(parseMediaName('after-login')).toEqual({ role: 'after', what: 'login' })
  })

  it('reads a before/after token as a suffix', () => {
    expect(parseMediaName('login-before')).toEqual({ role: 'before', what: 'login' })
    expect(parseMediaName('login-after')).toEqual({ role: 'after', what: 'login' })
  })

  it('matches case-insensitively but reports the role lower case', () => {
    expect(parseMediaName('Before-Login')).toEqual({ role: 'before', what: 'Login' })
  })

  it('keeps a multi-word what in order, with the token removed', () => {
    expect(parseMediaName('before-empty-state')).toEqual({ role: 'before', what: 'empty-state' })
  })

  it('gives a null role and the whole name when there is no before/after token', () => {
    expect(parseMediaName('z')).toEqual({ role: null, what: 'z' })
    expect(parseMediaName('empty-state')).toEqual({ role: null, what: 'empty-state' })
  })

  it('gives an empty what for a bare before/after name', () => {
    expect(parseMediaName('before')).toEqual({ role: 'before', what: '' })
  })
})

describe('humanize', () => {
  it('turns hyphens and underscores into spaces and capitalises the first letter', () => {
    expect(humanize('empty-state')).toBe('Empty state')
    expect(humanize('empty_state')).toBe('Empty state')
    expect(humanize('z')).toBe('Z')
  })

  it('leaves an empty name empty', () => {
    expect(humanize('')).toBe('')
  })
})

describe('screenshotsMarkdown', () => {
  it('pairs before-x/after-x into a Before | After table, and captions the rest (issue #311 acceptance example)', () => {
    const markdown = screenshotsMarkdown(['before-x.png', 'after-x.png', 'after-y.png', 'z.png'], urlFor)
    expect(markdown).toBe(
      [
        '|  | Before | After |',
        '| --- | --- | --- |',
        '| x | ![before-x](https://example.com/before-x.png) | ![after-x](https://example.com/after-x.png) |',
        '',
        '**After**',
        '',
        '![after-y](https://example.com/after-y.png)',
        '',
        '**Z**',
        '',
        '![z](https://example.com/z.png)',
      ].join('\n'),
    )
  })

  it('pairs the two naming styles with each other', () => {
    const markdown = screenshotsMarkdown(['before-login.png', 'login-after.png'], urlFor)
    expect(markdown).toContain('| login | ![before-login](https://example.com/before-login.png)')
    expect(markdown).not.toContain('**Before**')
    expect(markdown).not.toContain('**After**')
  })

  it('sorts multiple pairs by their shared name', () => {
    const markdown = screenshotsMarkdown(
      ['before-zebra.png', 'after-zebra.png', 'before-apple.png', 'after-apple.png'],
      urlFor,
    )
    const rows = markdown.split('\n').filter((line) => /^\| \w+ \|/.test(line))
    expect(rows).toEqual([expect.stringContaining('| apple |'), expect.stringContaining('| zebra |')])
  })

  it('leaves an unpaired before/after file captioned by its role alone, not its name', () => {
    const markdown = screenshotsMarkdown(['before-login.png'], urlFor)
    expect(markdown).toBe('**Before**\n\n![before-login](https://example.com/before-login.png)')
  })

  it('produces no table when nothing pairs', () => {
    const markdown = screenshotsMarkdown(['a.png', 'b.png'], urlFor)
    expect(markdown).not.toContain('| --- |')
    expect(markdown).toBe(
      ['**A**', '', '![a](https://example.com/a.png)', '', '**B**', '', '![b](https://example.com/b.png)'].join('\n'),
    )
  })

  it('returns an empty string for no screenshots', () => {
    expect(screenshotsMarkdown([], urlFor)).toBe('')
  })
})

describe('recordingsMarkdown', () => {
  it('keeps a plain name as the bold title, unchanged', () => {
    expect(recordingsMarkdown(['walkthrough'], recordingOf())).toBe(
      '**walkthrough**\n\n![walkthrough](https://example.com/walkthrough.gif)',
    )
  })

  it('folds a before/after label into the title, keeping the MP4 link', () => {
    const markdown = recordingsMarkdown(['before-login'], recordingOf(['before-login']))
    expect(markdown).toBe(
      [
        '**Before — login**',
        '',
        '![before-login](https://example.com/before-login.gif)',
        '',
        '[MP4](https://example.com/before-login.mp4)',
      ].join('\n'),
    )
  })

  it('titles a bare before/after recording by its role alone', () => {
    expect(recordingsMarkdown(['after'], recordingOf())).toBe('**After**\n\n![after](https://example.com/after.gif)')
  })

  it('joins several recordings with a blank line between them', () => {
    const markdown = recordingsMarkdown(['before-login', 'after-login'], recordingOf())
    expect(markdown.split('\n\n')).toEqual([
      '**Before — login**',
      '![before-login](https://example.com/before-login.gif)',
      '**After — login**',
      '![after-login](https://example.com/after-login.gif)',
    ])
  })
})

describe('mediaBody', () => {
  const recording = recordingOf()

  it('inserts Screenshots and Recordings sections just before Closes #', () => {
    const body = mediaBody({
      body: 'Because:\n- reason\n\nThis commit:\n- change\n\nCloses #42\n',
      pngs: ['before-x.png', 'after-x.png'],
      gifs: ['demo'],
      urlFor,
      recording,
    })
    expect(body).toBe(
      [
        'Because:',
        '- reason',
        '',
        'This commit:',
        '- change',
        '',
        'Screenshots:',
        '',
        '|  | Before | After |',
        '| --- | --- | --- |',
        '| x | ![before-x](https://example.com/before-x.png) | ![after-x](https://example.com/after-x.png) |',
        '',
        'Recordings:',
        '',
        '**demo**',
        '',
        '![demo](https://example.com/demo.gif)',
        '',
        'Closes #42',
        '',
      ].join('\n'),
    )
  })

  it('drops a Generated with Claude Code footer', () => {
    const body = mediaBody({
      body: 'Because:\n- reason\n\nCloses #7\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
      pngs: [],
      gifs: [],
      urlFor,
      recording,
    })
    expect(body).toBe('Because:\n- reason\n\nCloses #7\n')
  })

  it('re-running on an already-published body replaces the old sections rather than piling on a second copy', () => {
    const original = 'Because:\n- reason\n\nCloses #9\n'
    const first = mediaBody({ body: original, pngs: ['z.png'], gifs: [], urlFor, recording })
    expect(first).toContain('Screenshots:')

    const second = mediaBody({ body: first, pngs: ['after-y.png'], gifs: ['demo'], urlFor, recording })
    expect(second.match(/^Screenshots:/gm)).toHaveLength(1)
    expect(second.match(/^Recordings:/gm)).toHaveLength(1)
    expect(second).not.toContain('z.png')
    expect(second).toContain('after-y.png')
    expect(second).toContain('**demo**')
    expect(second.trimEnd().endsWith('Closes #9')).toBe(true)
  })

  it('appends the sections at the end when the body has no Closes #', () => {
    const body = mediaBody({ body: 'Some notes.\n', pngs: ['a.png'], gifs: [], urlFor, recording })
    expect(body).toBe('Some notes.\n\nScreenshots:\n\n**A**\n\n![a](https://example.com/a.png)\n')
  })

  it('produces neither section when there is no media', () => {
    const body = mediaBody({ body: 'Because:\n- reason\n\nCloses #1\n', pngs: [], gifs: [], urlFor, recording })
    expect(body).toBe('Because:\n- reason\n\nCloses #1\n')
  })
})

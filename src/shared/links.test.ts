import { describe, expect, it } from 'vitest'
import { checkLink, LinkCheckKind, OPENABLE_PROTOCOLS, openableUrl } from './links'

describe('checkLink', () => {
  it('opens web and mail links, as the URL parser writes them out', () => {
    expect(checkLink('https://example.com/docs?page=2#limits')).toEqual({
      kind: LinkCheckKind.Openable,
      url: 'https://example.com/docs?page=2#limits',
    })
    expect(checkLink('http://localhost:4173')).toEqual({ kind: LinkCheckKind.Openable, url: 'http://localhost:4173/' })
    expect(checkLink('mailto:support@example.com')).toEqual({
      kind: LinkCheckKind.Openable,
      url: 'mailto:support@example.com',
    })
    expect(OPENABLE_PROTOCOLS).toEqual(['http:', 'https:', 'mailto:'])
  })

  it('takes a scheme in any case, and opens it lower-cased', () => {
    expect(checkLink('HTTPS://Example.COM/Docs')).toEqual({
      kind: LinkCheckKind.Openable,
      url: 'https://example.com/Docs',
    })
    expect(checkLink('MailTo:support@example.com')).toEqual({
      kind: LinkCheckKind.Openable,
      url: 'mailto:support@example.com',
    })
  })

  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JaVaScRiPt:alert(1)', 'javascript:'],
    ['file:///etc/passwd', 'file:'],
    ['FILE:///Users/sample/.ssh/id_ed25519', 'file:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['vbscript:msgbox(1)', 'vbscript:'],
    ['glade://task/t1', 'glade:'],
    ['ftp://example.com/file', 'ftp:'],
    ['blob:https://example.com/0f1e', 'blob:'],
    ['about:blank', 'about:'],
  ])('refuses %s, naming its scheme', (raw, scheme) => {
    expect(checkLink(raw)).toEqual({ kind: LinkCheckKind.Refused, scheme })
    expect(openableUrl(raw)).toBeNull()
  })

  it.each([
    [' javascript:alert(1)', 'a leading space'],
    ['javascript:alert(1) ', 'a trailing space'],
    ['java\tscript:alert(1)', 'a tab the parser drops'],
    ['java\nscript:alert(1)', 'a newline the parser drops'],
    ['\u0000javascript:alert(1)', 'a leading control character'],
    ['\u001fhttps://example.com', 'a control character before a web link'],
    ['https://exa\nmple.com', 'a newline inside a web link'],
    ['https://example.com/\u007f', 'a delete character'],
    ['https://example.com/a b', 'a space inside a web link'],
    ['https://example.com/ ', 'a no-break space'],
  ])('refuses %j, with %s in it', (raw) => {
    expect(checkLink(raw)).toEqual({ kind: LinkCheckKind.Invalid })
    expect(openableUrl(raw)).toBeNull()
  })

  it.each(['', 'docs/setup.md', '/docs/setup.md', '#limits', '//example.com', 'example.com', 'https://'])(
    'refuses %j, which is no whole URL',
    (raw) => {
      expect(checkLink(raw)).toEqual({ kind: LinkCheckKind.Invalid })
    },
  )
})

describe('openableUrl', () => {
  it('answers with the link to open', () => {
    expect(openableUrl('https://example.com')).toBe('https://example.com/')
    expect(openableUrl('javascript:alert(1)')).toBeNull()
  })
})

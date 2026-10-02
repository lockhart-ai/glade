import { describe, expect, it } from 'vitest'
import {
  checkArtifactUrl,
  defaultLinkTitle,
  linkDetail,
  LinkKind,
  linkLabel,
  MAX_ARTIFACT_URL_LENGTH,
  recogniseLink,
} from './artifactLinks'

describe('checkArtifactUrl', () => {
  it('takes a whole http or https URL, normalised as the URL parser writes it out', () => {
    expect(checkArtifactUrl('https://github.com/acme/api/pull/412')).toEqual({
      ok: true,
      url: 'https://github.com/acme/api/pull/412',
    })
    // The scheme and host lower-cased, a default port dropped, a bare host given its `/`, the whitespace around trimmed.
    expect(checkArtifactUrl('  HTTPS://GitHub.COM:443/acme/api/pull/412  ')).toEqual({
      ok: true,
      url: 'https://github.com/acme/api/pull/412',
    })
    expect(checkArtifactUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
    // The path, query and fragment are kept as they are: they can mean something.
    expect(checkArtifactUrl('https://example.com/Docs?page=2#Limits')).toEqual({
      ok: true,
      url: 'https://example.com/Docs?page=2#Limits',
    })
  })

  it.each([
    ['javascript:alert(1)', 'javascript: links can’t be artifacts: only http and https'],
    ['file:///etc/passwd', 'file: links can’t be artifacts: only http and https'],
    ['data:text/html,<b>hi</b>', 'data: links can’t be artifacts: only http and https'],
    ['vscode://file/etc/hosts', 'vscode: links can’t be artifacts: only http and https'],
    // A mail link opens, but it isn't a page to come back to.
    ['mailto:support@example.com', 'mailto: links can’t be artifacts: only http and https'],
  ])('refuses %s', (raw, reason) => {
    expect(checkArtifactUrl(raw)).toEqual({ ok: false, reason: reason.replace('’', "'") })
  })

  it('refuses what isn’t a whole URL, hides something in it, or carries a password', () => {
    for (const raw of ['', 'github.com/acme/api/pull/412', '/browse/API-123', '#412', 'java\tscript:alert(1)']) {
      expect(checkArtifactUrl(raw), raw).toMatchObject({ ok: false, reason: expect.stringContaining('whole web') })
    }
    expect(checkArtifactUrl('https://example.com/a b')).toMatchObject({ ok: false })
    expect(checkArtifactUrl('https://me:hunter2@example.com/')).toEqual({
      ok: false,
      reason: 'has a user name or password in it',
    })
    expect(checkArtifactUrl('https://me@example.com/')).toMatchObject({ ok: false })
  })

  it('refuses one longer than any real link, at the limit and not before', () => {
    const base = 'https://example.com/'
    const at = base + 'a'.repeat(MAX_ARTIFACT_URL_LENGTH - base.length)
    expect(checkArtifactUrl(at)).toEqual({ ok: true, url: at })
    expect(checkArtifactUrl(`${at}a`)).toEqual({ ok: false, reason: 'is longer than 2048 characters' })
  })
})

describe('recogniseLink', () => {
  it('knows a GitHub pull request, and the pages under it', () => {
    for (const url of [
      'https://github.com/acme/api/pull/412',
      'https://github.com/acme/api/pull/412/',
      'https://github.com/acme/api/pull/412/files',
      'https://github.com/acme/api/pull/412#issuecomment-1',
      'https://www.github.com/acme/api/pull/412?w=1',
    ]) {
      expect(recogniseLink(url), url).toEqual({ kind: LinkKind.PullRequest, repo: 'acme/api', number: 412 })
    }
  })

  it('knows a GitHub issue', () => {
    expect(recogniseLink('https://github.com/acme/api/issues/398')).toEqual({
      kind: LinkKind.Issue,
      repo: 'acme/api',
      number: 398,
    })
  })

  it('knows a Jira ticket on Atlassian, or a Jira of your own, by its key', () => {
    expect(recogniseLink('https://acme.atlassian.net/browse/API-123')).toEqual({
      kind: LinkKind.Ticket,
      key: 'API-123',
    })
    expect(recogniseLink('https://acme.atlassian.net/browse/api-123/')).toEqual({
      kind: LinkKind.Ticket,
      key: 'API-123',
    })
    expect(recogniseLink('https://jira.acme.dev/jira/browse/OPS_2-7?focusedCommentId=1')).toEqual({
      kind: LinkKind.Ticket,
      key: 'OPS_2-7',
    })
  })

  it('takes anything else for a page, by its domain, GitHub Enterprise hosts and GitHub’s other pages included', () => {
    const web = (domain: string) => ({ kind: LinkKind.Web, domain })
    expect(recogniseLink('https://github.acme.com/acme/api/pull/412')).toEqual(web('github.acme.com'))
    expect(recogniseLink('https://ghe.example.com/acme/api/issues/3')).toEqual(web('ghe.example.com'))
    expect(recogniseLink('https://github.com/acme/api')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com/acme/api/pulls')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com/acme/api/pull/new')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com/acme/api/pull/0')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com/acme/api/commit/412')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com//api/pull/412')).toEqual(web('github.com'))
    expect(recogniseLink('https://github.com/acme//pull/412')).toEqual(web('github.com'))
    expect(recogniseLink('https://notgithub.com/acme/api/pull/412')).toEqual(web('notgithub.com'))
    expect(recogniseLink('https://acme.atlassian.net/browse/API')).toEqual(web('acme.atlassian.net'))
    expect(recogniseLink('https://acme.atlassian.net/browse/API-123/comments')).toEqual(web('acme.atlassian.net'))
    expect(recogniseLink('https://www.example.com/style/code-samples')).toEqual(web('example.com'))
    expect(recogniseLink('http://localhost:4173/')).toEqual(web('localhost'))
  })
})

describe('what a link’s row says', () => {
  it('names a PR or issue by #N and its repo, a ticket by its key, and a page by its domain', () => {
    const pr = recogniseLink('https://github.com/acme/api/pull/412')
    const issue = recogniseLink('https://github.com/acme/api/issues/398')
    const ticket = recogniseLink('https://acme.atlassian.net/browse/API-123')
    const page = recogniseLink('https://example.com/style')

    expect([pr, issue, ticket, page].map(linkLabel)).toEqual(['#412', '#398', 'API-123', 'example.com'])
    expect([pr, issue, ticket, page].map(linkDetail)).toEqual([
      '#412 · acme/api',
      '#398 · acme/api',
      'API-123',
      'example.com',
    ])
  })
})

describe('defaultLinkTitle', () => {
  it('is what the link says, when it says something other than its address', () => {
    expect(defaultLinkTitle('https://github.com/acme/api/pull/412', '  Navigation refresh ')).toBe('Navigation refresh')
    expect(defaultLinkTitle('https://example.com/docs', 'The docs')).toBe('The docs')
  })

  it('is #N, the ticket’s key, or the address without its scheme for a bare link', () => {
    expect(defaultLinkTitle('https://github.com/acme/api/pull/412')).toBe('#412')
    expect(defaultLinkTitle('https://github.com/acme/api/pull/412', 'https://github.com/acme/api/pull/412')).toBe(
      '#412',
    )
    expect(defaultLinkTitle('https://github.com/acme/api/issues/398', 'github.com/acme/api/issues/398/')).toBe('#398')
    expect(defaultLinkTitle('https://acme.atlassian.net/browse/API-123', ' ')).toBe('API-123')
    expect(defaultLinkTitle('https://example.com/', 'https://example.com')).toBe('example.com')
    expect(defaultLinkTitle('http://example.com/docs/limits')).toBe('example.com/docs/limits')
  })
})

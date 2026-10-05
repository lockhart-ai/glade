/**
 * Link artifacts (#407): the PRs, issues, tickets and other web pages a task is about, kept in its Todos tab next to
 * its files. Which addresses may be one (`checkArtifactUrl`: a whole `http:` or `https:` URL, nothing else), the one
 * form each is kept under (its normalised URL, so the same page given twice is one artifact), and what it is, from the
 * URL alone with no network call (`recogniseLink`): a GitHub pull request or issue, a Jira ticket, or any other page.
 */
import { checkLink, LinkCheckKind } from './links'

/** The longest address a link artifact may have, in characters: longer than any real PR or ticket link. */
export const MAX_ARTIFACT_URL_LENGTH = 2048

/** The schemes a link artifact may have, as `URL.protocol` names them: the web only (a `mailto:` link opens, but isn't one). */
const ARTIFACT_PROTOCOLS: readonly string[] = ['http:', 'https:']

/** Whether an address may be a link artifact (`checkArtifactUrl`). */
export type ArtifactUrlCheck =
  | {
      readonly ok: true
      /** The address as the URL parser writes it out: what the artifact is kept, keyed and opened by. */
      readonly url: string
    }
  | {
      readonly ok: false
      /** Why not, to tell whoever gave it: e.g. `javascript: links can't be artifacts: only http and https`. */
      readonly reason: string
    }

/**
 * Whether `raw` (trimmed) may be a link artifact: a whole `http:` or `https:` URL (as `checkLink` reads one: no
 * whitespace or control characters in it), with no user name or password in it, and at most
 * `MAX_ARTIFACT_URL_LENGTH` characters. Answers its normalised form (`new URL(raw).href`, which lower-cases the
 * scheme and host and drops a default port), or why not.
 */
export function checkArtifactUrl(raw: string): ArtifactUrlCheck {
  const given = raw.trim()
  if (given.length > MAX_ARTIFACT_URL_LENGTH) {
    return { ok: false, reason: `is longer than ${String(MAX_ARTIFACT_URL_LENGTH)} characters` }
  }
  const check = checkLink(given)
  switch (check.kind) {
    case LinkCheckKind.Invalid:
      return { ok: false, reason: `${given} isn't a whole web address (http or https)` }
    case LinkCheckKind.Refused:
      return { ok: false, reason: `${check.scheme} links can't be artifacts: only http and https` }
    case LinkCheckKind.Openable: {
      const url = new URL(check.url)
      if (!ARTIFACT_PROTOCOLS.includes(url.protocol)) {
        return { ok: false, reason: `${url.protocol} links can't be artifacts: only http and https` }
      }
      if (url.username !== '' || url.password !== '') {
        return { ok: false, reason: 'has a user name or password in it' }
      }
      return { ok: true, url: url.href }
    }
  }
}

/** What a link artifact is, from its URL alone (`recogniseLink`). */
export enum LinkKind {
  /** A GitHub pull request: `github.com/<owner>/<repo>/pull/<n>`. */
  PullRequest = 'pull_request',
  /** A GitHub issue: `github.com/<owner>/<repo>/issues/<n>`. */
  Issue = 'issue',
  /** A Jira ticket: `…/browse/<KEY>-<n>`, on `*.atlassian.net` or a Jira of your own. */
  Ticket = 'ticket',
  /** Any other web page. */
  Web = 'web',
}

/** What a link artifact is, and what its row says of it. */
export type RecognisedLink =
  | {
      readonly kind: LinkKind.PullRequest | LinkKind.Issue
      /** `owner/repo`. */
      readonly repo: string
      readonly number: number
    }
  | {
      readonly kind: LinkKind.Ticket
      /** The ticket's key, upper-cased: `API-123`. */
      readonly key: string
    }
  | {
      readonly kind: LinkKind.Web
      /** The host, without a leading `www.`: `example.com`. */
      readonly domain: string
    }

/** GitHub's own hosts. A GitHub Enterprise host (`github.acme.com`) can't be told from any other site, so it isn't. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com'])

/** A whole number from 1, as a path part has it; null for anything else. */
function issueNumber(part: string | undefined): number | null {
  if (part === undefined || !/^[1-9]\d{0,15}$/.test(part)) return null
  return Number(part)
}

/** A Jira ticket's key at the end of a path, after `browse/`: `API-123`. */
const JIRA_TICKET = /\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)\/?$/

/** A GitHub pull request or issue, from its URL's host and path; null for anything else. */
function githubLink(url: URL): RecognisedLink | null {
  if (!GITHUB_HOSTS.has(url.hostname)) return null
  const [owner, repo, section, part] = url.pathname.split('/').slice(1)
  const number = issueNumber(part)
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || number === null) return null
  if (section === 'pull') return { kind: LinkKind.PullRequest, repo: `${owner}/${repo}`, number }
  if (section === 'issues') return { kind: LinkKind.Issue, repo: `${owner}/${repo}`, number }
  return null
}

/**
 * What the link artifact at `url` (a URL `checkArtifactUrl` accepted) is, from the URL alone: a GitHub pull request or
 * issue (on github.com, the pages under it, like a PR's Files, included), a Jira ticket (a path ending in
 * `/browse/<KEY>-<n>`), or any other page, by its domain.
 */
export function recogniseLink(url: string): RecognisedLink {
  const parsed = new URL(url)
  const github = githubLink(parsed)
  if (github !== null) return github
  const ticket = JIRA_TICKET.exec(parsed.pathname)?.[1]
  if (ticket !== undefined) return { kind: LinkKind.Ticket, key: ticket.toUpperCase() }
  return { kind: LinkKind.Web, domain: parsed.hostname.replace(/^www\./, '') }
}

/** What a link's row names it by, after its title: `#412` for a PR or issue, `API-123` for a ticket, else its domain. */
export function linkLabel(link: RecognisedLink): string {
  switch (link.kind) {
    case LinkKind.PullRequest:
    case LinkKind.Issue:
      return `#${String(link.number)}`
    case LinkKind.Ticket:
      return link.key
    case LinkKind.Web:
      return link.domain
  }
}

/** What a link artifact's row says of it, after its title: `#412 · acme/api`, `API-123` or `example.com`. */
export function linkDetail(link: RecognisedLink): string {
  switch (link.kind) {
    case LinkKind.PullRequest:
    case LinkKind.Issue:
      return `${linkLabel(link)} · ${link.repo}`
    case LinkKind.Ticket:
    case LinkKind.Web:
      return linkLabel(link)
  }
}

/** A URL without its scheme or a lone trailing `/`: `example.com/docs/limits`. */
function bareAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/**
 * What to call a link artifact when nothing else names it: the link's own text, unless that's empty or just its
 * address; then `#412` for a PR or issue, `API-123` for a ticket, and the address without its scheme for any other page.
 */
export function defaultLinkTitle(url: string, text = ''): string {
  const said = text.trim()
  if (said !== '' && said !== url && bareAddress(said) !== bareAddress(url)) return said
  const link = recogniseLink(url)
  return link.kind === LinkKind.Web ? bareAddress(url) : linkLabel(link)
}

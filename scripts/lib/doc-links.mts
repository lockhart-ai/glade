// Checking the links in the repo's docs (#242): every relative link and image in a Markdown file, and every link in
// llms.txt to this repo on GitHub, must lead to a file that's there, and a `#fragment` into a Markdown file to one of
// its headings. Plain functions over the file system, so they can be unit tested on a folder of their own; the check
// itself runs as a test (doc-links.test.ts) over the real repo.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Where the repo's files are on GitHub: llms.txt links here, so it works when fetched on its own. */
export const GITHUB_BLOB = 'https://github.com/lockhart-ai/glade/blob/main/'

/** A link in a doc: where it points, and the line it's on. */
export interface DocLink {
  readonly target: string
  readonly line: number
}

/** A link that doesn't resolve: the file it's in (relative to the repo root), its line, target and why. */
export interface BrokenLink {
  readonly file: string
  readonly line: number
  readonly target: string
  readonly reason: string
}

/** What to check. */
export interface LinkCheck {
  /** The repo root, which `files` are relative to. */
  readonly root: string
  /** The files to check, relative to `root`. */
  readonly files: readonly string[]
}

/** Text blanked out, keeping its line breaks, so what's around it keeps its lines. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

/** Fenced code blocks, blanked out, so a heading or link written as an example isn't one. */
function withoutFences(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
}

/** Fenced code blocks and inline code, blanked out. */
function withoutCode(markdown: string): string {
  return withoutFences(markdown).replace(/`[^`\n]*`/g, blank)
}

/** The line `index` is on in `text`, from 1. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/** Every link and image in a Markdown file: `[text](target)`, `![alt](target "title")`, and HTML `src`/`href`. */
export function extractLinks(markdown: string): DocLink[] {
  const text = withoutCode(markdown)
  const links: DocLink[] = []
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    links.push({ target: match[1] ?? '', line: lineAt(text, match.index) })
  }
  for (const match of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    links.push({ target: match[1] ?? '', line: lineAt(text, match.index) })
  }
  return links.sort((a, b) => a.line - b.line)
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces to hyphens. */
export function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** The anchors a Markdown file's headings make, with GitHub's `-1`, `-2`, … for repeats. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = slugOf((match[1] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`)
  }
  return anchors
}

/** Whether a link leaves the repo: a URL with a scheme (other than this repo on GitHub), or an email address. */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith(GITHUB_BLOB)
}

/** Why a link from `file` doesn't resolve, or null when it does. */
function problemOf(check: LinkCheck, file: string, target: string): string | null {
  const [rawPath = '', fragment] = target.split('#', 2)
  const path = decodeURI(rawPath)
  let resolved: string
  if (target.startsWith(GITHUB_BLOB)) resolved = resolve(check.root, path.slice(GITHUB_BLOB.length))
  else if (path === '') resolved = resolve(check.root, file)
  else if (path.startsWith('/')) resolved = resolve(check.root, `.${path}`)
  else resolved = resolve(check.root, dirname(file), path)
  const inRepo = relative(check.root, resolved)
  if (inRepo.startsWith('..')) return 'it points outside the repo'
  if (!existsSync(resolved)) return 'no such file'
  if (fragment === undefined || fragment === '' || !resolved.endsWith('.md') || statSync(resolved).isDirectory()) {
    return null
  }
  return anchorsOf(readFileSync(resolved, 'utf8')).has(fragment) ? null : `no heading #${fragment}`
}

/** Every link in the files that doesn't resolve. */
export function brokenLinks(check: LinkCheck): BrokenLink[] {
  return check.files.flatMap((file) =>
    extractLinks(readFileSync(join(check.root, file), 'utf8')).flatMap(({ target, line }) => {
      if (isExternal(target)) return []
      const reason = problemOf(check, file, target)
      return reason === null ? [] : [{ file, line, target, reason }]
    }),
  )
}

/** The Markdown files in `folder` (relative to `root`) and the folders under it, but not under `skip`. */
export function markdownFiles(root: string, folder: string, skip: readonly string[] = []): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true })
    .flatMap((entry) => {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`
      if (entry.isDirectory()) {
        return folder === '' || skip.includes(path) ? [] : markdownFiles(root, path, skip)
      }
      return entry.name.endsWith('.md') ? [path] : []
    })
    .sort()
}

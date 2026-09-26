// Builds a PR body's Screenshots and Recordings sections for scripts/publish-media.mjs (#311). Screenshots named
// `before-<what>` / `after-<what>` (either as a prefix, `before-x`, or a suffix, `x-before`) are paired by their
// shared `<what>` and shown side by side in a Before | After table; every other screenshot gets a bold caption above
// it, and a recording gets a Before / After label folded into its existing bold title. Plain functions over strings,
// so the body can be unit tested without touching the network or git.

/** A screenshot or recording's role, from its file name; null when the name has neither word. */
export type MediaRole = 'before' | 'after' | null

/** A file's role and the rest of its name (its pairing key), from parsing its base name (no extension). */
export interface ParsedMediaName {
  readonly role: MediaRole
  /** The base name with the `before`/`after` token removed; the base name itself when there was none. */
  readonly what: string
}

const ROLE_LABELS: Record<'before' | 'after', string> = { before: 'Before', after: 'After' }

/**
 * Reads a `before`/`after` token out of a hyphenated base name, wherever it falls (`before-login` and
 * `login-before` both give `{ role: 'before', what: 'login' }`). A name with neither token gets a null role and
 * `what` is the whole name.
 */
export function parseMediaName(baseName: string): ParsedMediaName {
  const tokens = baseName.split('-')
  const match = tokens.find((token) => token.toLowerCase() === 'before' || token.toLowerCase() === 'after')
  if (match === undefined) return { role: null, what: baseName }
  const role = match.toLowerCase() as 'before' | 'after'
  let dropped = false
  const what = tokens
    .filter((token) => {
      if (!dropped && token.toLowerCase() === role) {
        dropped = true
        return false
      }
      return true
    })
    .join('-')
  return { role, what }
}

/** A hyphenated or underscored name as prose: `empty-state` to `Empty state`. */
export function humanize(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase())
}

/** A screenshot file, with its name parsed. */
interface Screenshot {
  readonly file: string
  readonly base: string
  readonly role: MediaRole
  readonly what: string
}

/**
 * The Screenshots section's body: a Before | After table for every `before`/`after` pair sharing a `what`, sorted by
 * it, then every other screenshot (unpaired `before`/`after` files included) with a bold caption above it — the
 * role's name, or the humanised base name when the file has neither.
 */
export function screenshotsMarkdown(pngs: readonly string[], urlFor: (file: string) => string): string {
  const shots: Screenshot[] = pngs.map((file) => {
    const base = file.slice(0, -'.png'.length)
    const { role, what } = parseMediaName(base)
    return { file, base, role, what }
  })

  const byWhat = new Map<string, Screenshot[]>()
  for (const shot of shots) {
    if (shot.role === null) continue
    byWhat.set(shot.what, [...(byWhat.get(shot.what) ?? []), shot])
  }

  const paired = new Set<string>()
  const rows: { what: string; before: Screenshot; after: Screenshot }[] = []
  for (const [what, group] of byWhat) {
    const before = group.find((shot) => shot.role === 'before')
    const after = group.find((shot) => shot.role === 'after')
    if (!before || !after) continue
    rows.push({ what, before, after })
    paired.add(before.file)
    paired.add(after.file)
  }
  rows.sort((a, b) => a.what.localeCompare(b.what))

  const image = (shot: Screenshot): string => `![${shot.base}](${urlFor(shot.file)})`

  const blocks: string[] = []
  if (rows.length) {
    blocks.push(
      [
        '|  | Before | After |',
        '| --- | --- | --- |',
        ...rows.map((row) => `| ${row.what} | ${image(row.before)} | ${image(row.after)} |`),
      ].join('\n'),
    )
  }
  for (const shot of shots) {
    if (paired.has(shot.file)) continue
    const caption = shot.role ? ROLE_LABELS[shot.role] : humanize(shot.what)
    blocks.push(`**${caption}**\n\n${image(shot)}`)
  }
  return blocks.join('\n\n')
}

/**
 * The Recordings section's body: each recording keeps its bold title (the base name, unchanged, as before), except
 * that a `before`/`after` file folds a `Before`/`After` label into it. `recording` renders one recording's media (its
 * GIF, and an MP4 link when it has one), by base name, exactly as before.
 */
export function recordingsMarkdown(gifs: readonly string[], recording: (name: string) => readonly string[]): string {
  return gifs
    .map((name) => {
      const { role, what } = parseMediaName(name)
      const title = role ? (what ? `${ROLE_LABELS[role]} — ${what}` : ROLE_LABELS[role]) : name
      return [`**${title}**`, ...recording(name)].join('\n\n')
    })
    .join('\n\n')
}

/** What `mediaBody` needs to rebuild a PR body's media sections. */
export interface MediaBodyOptions {
  /** The PR's current body. */
  readonly body: string
  /** Screenshot file names, with their `.png` extension. */
  readonly pngs: readonly string[]
  /** Recording base names, without extension. */
  readonly gifs: readonly string[]
  /** Resolves a media file name (with extension) to its published URL. */
  readonly urlFor: (file: string) => string
  /** Renders one recording's media lines (its GIF, and an MP4 link when it has one), by base name. */
  readonly recording: (name: string) => readonly string[]
}

/**
 * The PR's new body: its `Generated with Claude Code` footer and any existing Screenshots/Recordings sections
 * dropped, and fresh ones inserted just before `Closes #`, so publishing again (or re-publishing to a body that
 * already has media) always leaves exactly one of each section.
 */
export function mediaBody(options: MediaBodyOptions): string {
  const { pngs, gifs, urlFor, recording } = options
  let body = options.body.replace(/\r\n/g, '\n')
  body = body.replace(/\n*(🤖 )?Generated with \[?Claude Code[\s\S]*$/, '')
  body = body.replace(/^(Screenshots|Recordings):[\s\S]*?(?=^(?:Screenshots|Recordings):|^Closes #|(?![\s\S]))/gm, '')
  body = body.trimEnd() + '\n\n'

  let sections = ''
  if (pngs.length) sections += `Screenshots:\n\n${screenshotsMarkdown(pngs, urlFor)}\n\n`
  if (gifs.length) sections += `Recordings:\n\n${recordingsMarkdown(gifs, recording)}\n\n`

  const closes = body.lastIndexOf('Closes #')
  body = closes >= 0 ? body.slice(0, closes) + sections + body.slice(closes) : body + sections
  return body.trimEnd() + '\n'
}

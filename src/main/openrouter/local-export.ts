import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocalTranscriptExport {
  readonly configDir: string
  readonly projectKey: string
  readonly sessionId: string
}

/**
 * The identity two copies of the same entry are matched by. The SDK's own transcript lines always carry the
 * entry's `uuid`, which is also what the store's own `append()` upserts on (`transcripts.ts`, `uuid:${uuid}`). An
 * entry with none (so far only `agent_metadata` sidecars, which this export never sees: it's one subpath, `''`)
 * has no identity either place ever gives it twice, so a content hash stands in, to keep a repeat export of the
 * same leg from appending it again rather than to match anything the store itself would.
 */
function entryIdentity(entry: unknown): string {
  const uuid =
    typeof entry === 'object' && entry !== null && typeof (entry as { uuid?: unknown }).uuid === 'string'
      ? ((entry as { uuid?: unknown }).uuid as string)
      : undefined
  return uuid === undefined
    ? `hash:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`
    : `uuid:${uuid}`
}

/**
 * Writes a mirrored session's entries into the real Claude config's own transcript file, so a Claude-model start
 * can resume straight from it without ever passing `sessionStore` — and so without the Agent SDK building its
 * `claude-resume-<id>` temporary folder, which copies the login in with its refresh token stripped (`docs/sdk-
 * notes.md`, "Cross-source resume and the login copy").
 *
 * Merges by identity instead of rewriting the file: a retry can call this again mid-leg, after the live process
 * has already appended lines of its own that the store doesn't have yet (nothing mirrors a Claude leg's writes any
 * more — `runtime.ts` only syncs at a handoff). Overwriting would discard those. This appends, in one write, only
 * the store's entries not already present locally, in the store's own (chronological) order.
 *
 * Throws on anything that stops it from being sure the merge is complete — an unreadable existing file, a write
 * failure — so the caller can fall back to the session store rather than start Claude on a file it can't vouch for.
 */
export async function exportSessionToLocal(
  store: SessionStore,
  { configDir, projectKey, sessionId }: LocalTranscriptExport,
): Promise<void> {
  const dir = join(configDir, 'projects', projectKey)
  const path = join(dir, `${sessionId}.jsonl`)
  const existing = new Set<string>()
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  for (const line of current.split('\n')) {
    if (line.trim() === '') continue
    // Parsed to `unknown` and taken only as an object: nothing else about the file's lines is trusted, so a line
    // that isn't one fails the export (and the caller falls back to the session store) rather than slipping past
    // with an identity that never matches.
    const entry: unknown = JSON.parse(line)
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`A line in the existing transcript is not an entry object: ${path}`)
    }
    existing.add(entryIdentity(entry))
  }
  const entries = (await store.load({ projectKey, sessionId })) ?? []
  const missing = entries.filter((entry) => !existing.has(entryIdentity(entry)))
  if (missing.length === 0) return
  // Mode 0o700 for the directory, 0o600 for the file: the Agent SDK's own modes when it writes a resumed session's
  // temporary folder (`sdk.mjs`, the `claude-resume-<id>` writer), matched so a plain `resume` finds the same thing.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // A file whose last line has no trailing newline (a truncated or hand-edited one) would glue the first appended
  // entry onto it, corrupting both; a newline ahead of the entries keeps every line its own. One write either way.
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(path, separator + missing.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
}

import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { createReadStream } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

export interface LocalTranscriptImport {
  readonly configDir: string
  readonly sessionId: string
}
const entry = z.object({ type: z.string() }).catchall(z.unknown()) satisfies z.ZodType<SessionStoreEntry>

async function appendFile(store: SessionStore, path: string, key: SessionKey): Promise<void> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let batch: SessionStoreEntry[] = []
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      batch.push(entry.parse(JSON.parse(line) as unknown))
      if (batch.length >= 500) {
        await store.append(key, batch)
        batch = []
      }
    }
    if (batch.length > 0) await store.append(key, batch)
  } finally {
    lines.close()
  }
}

/** SDK 0.3.283's local JSONL layout, including opaque child entries and their metadata sidecars. */
export async function importLocalTranscript(
  store: SessionStore,
  { configDir, sessionId }: LocalTranscriptImport,
): Promise<void> {
  if (basename(sessionId) !== sessionId || sessionId === '' || sessionId === '.' || sessionId === '..')
    throw new Error('Invalid saved session ID.')
  const projects = join(configDir, 'projects')
  const directories = await readdir(projects, { withFileTypes: true })
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const path = join(projects, directory.name, `${sessionId}.jsonl`)
    try {
      await access(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    const key = { projectKey: directory.name, sessionId }
    await appendFile(store, path, key)
    const root = path.slice(0, -'.jsonl'.length)
    let children
    try {
      children = await readdir(join(root, 'subagents'), { recursive: true, withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith('.jsonl')) continue
      const file = join(child.parentPath, child.name)
      const childKey = { ...key, subpath: relative(root, file).slice(0, -'.jsonl'.length).split(sep).join('/') }
      await appendFile(store, file, childKey)
      let metadata: unknown
      try {
        metadata = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as unknown
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      await store.append(childKey, [{ type: 'agent_metadata', ...z.record(z.string(), z.unknown()).parse(metadata) }])
    }
    return
  }
  throw new Error('The saved SDK transcript file was not found.')
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { importLocalTranscript } from './local-transcripts'
import { sqliteSessionStore } from './transcripts'

let dir: string
let database: TestDatabase
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glade-transcript-'))
  database = openTestDatabase()
  await mkdir(join(dir, 'projects', 'empty'), { recursive: true })
  await mkdir(join(dir, 'projects', 'sample'), { recursive: true })
  await writeFile(join(dir, 'projects', 'ignored-file'), '')
})
afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

it('imports full local history in batches, preserving nested children and metadata sidecars', async () => {
  const store = sqliteSessionStore(database.db)
  const main = Array.from({ length: 503 }, (_, i) => ({
    type: 'user',
    uuid: `u${String(i)}`,
    content: 'Sample context',
  }))
  await writeFile(
    join(dir, 'projects', 'sample', 'saved.jsonl'),
    main.map((v) => JSON.stringify(v)).join('\n') + '\n\n',
  )
  const children = join(dir, 'projects', 'sample', 'saved', 'subagents')
  await mkdir(join(children, 'nested'), { recursive: true })
  await writeFile(
    join(children, 'agent-one.jsonl'),
    JSON.stringify({ type: 'assistant', uuid: 'a1', signature: 'sample' }),
  )
  await writeFile(join(children, 'agent-one.meta.json'), JSON.stringify({ title: 'Inspect tests' }))
  await writeFile(join(children, 'nested', 'agent-two.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1' }))
  await writeFile(join(children, 'ignore.txt'), 'not a transcript')
  await importLocalTranscript(store, { configDir: dir, sessionId: 'saved' })
  const key = { projectKey: 'sample', sessionId: 'saved' }
  expect(await store.load(key)).toEqual(main)
  expect(await store.listSubkeys?.(key)).toEqual(['subagents/agent-one', 'subagents/nested/agent-two'])
  expect(await store.load({ ...key, subpath: 'subagents/agent-one' })).toEqual([
    { type: 'assistant', uuid: 'a1', signature: 'sample' },
    { type: 'agent_metadata', title: 'Inspect tests' },
  ])
})

it('loads a transcript without children and refuses absent, invalid or corrupt history', async () => {
  const store = sqliteSessionStore(database.db)
  await writeFile(join(dir, 'projects', 'sample', 'saved.jsonl'), '{"type":"user","uuid":"u1"}\n')
  await importLocalTranscript(store, { configDir: dir, sessionId: 'saved' })
  for (const sessionId of ['../escape', '', '.', '..'])
    await expect(importLocalTranscript(store, { configDir: dir, sessionId })).rejects.toThrow('Invalid saved')
  await expect(importLocalTranscript(store, { configDir: dir, sessionId: 'missing' })).rejects.toThrow('not found')
  await expect(importLocalTranscript(store, { configDir: dir, sessionId: 'x'.repeat(256) })).rejects.toThrow(
    'ENAMETOOLONG',
  )
  await writeFile(join(dir, 'projects', 'sample', 'broken.jsonl'), 'invalid JSON')
  await expect(importLocalTranscript(store, { configDir: dir, sessionId: 'broken' })).rejects.toThrow()
  await mkdir(join(dir, 'projects', 'sample', 'saved'))
  await writeFile(join(dir, 'projects', 'sample', 'saved', 'subagents'), '')
  await expect(importLocalTranscript(store, { configDir: dir, sessionId: 'saved' })).rejects.toThrow('ENOTDIR')
  await rm(join(dir, 'projects', 'sample', 'saved', 'subagents'))
  await mkdir(join(dir, 'projects', 'sample', 'saved', 'subagents'))
  await writeFile(join(dir, 'projects', 'sample', 'saved', 'subagents', 'agent.jsonl'), '{"type":"assistant"}')
  await writeFile(join(dir, 'projects', 'sample', 'saved', 'subagents', 'agent.meta.json'), 'invalid JSON')
  await expect(importLocalTranscript(store, { configDir: dir, sessionId: 'saved' })).rejects.toThrow()
})

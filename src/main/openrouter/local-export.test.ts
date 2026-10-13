import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { exportSessionToLocal } from './local-export'
import { sqliteSessionStore } from './transcripts'

let dir: string
let database: TestDatabase
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glade-export-'))
  database = openTestDatabase()
})
afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

it('writes the store’s entries into a fresh local file, in the store’s order, with the SDK’s own modes', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'saved' }
  await store.append(key, [
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1' },
  ])
  await exportSessionToLocal(store, { configDir: dir, ...key })
  const path = join(dir, 'projects', 'sample', 'saved.jsonl')
  expect(
    (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown),
  ).toEqual([
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1' },
  ])
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(join(dir, 'projects', 'sample'))).mode & 0o777).toBe(0o700)
})

it('merges by the entry’s own id: skips what the local file already has, appends only the rest, in one write', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'saved' }
  await mkdir(join(dir, 'projects', 'sample'), { recursive: true })
  const path = join(dir, 'projects', 'sample', 'saved.jsonl')
  await writeFile(path, '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n')
  await store.append(key, [
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1' },
    { type: 'assistant', uuid: 'a2' },
  ])
  const before = await readFile(path)
  await exportSessionToLocal(store, { configDir: dir, ...key })
  const after = await readFile(path)
  // The original bytes are untouched (a rewrite, not an append, could reorder or duplicate them) and exactly the
  // one missing entry is appended after.
  expect(after.subarray(0, before.length)).toEqual(before)
  expect(after.subarray(before.length).toString()).toBe('{"type":"assistant","uuid":"a2"}\n')
  expect(before.toString()).toBe('{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n')
  expect(
    (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown),
  ).toEqual([
    { type: 'user', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1' },
    { type: 'assistant', uuid: 'a2' },
  ])
})

it('does nothing when the local file already has everything the store has (a same-leg retry)', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'saved' }
  await store.append(key, [{ type: 'user', uuid: 'u1' }])
  await exportSessionToLocal(store, { configDir: dir, ...key })
  const path = join(dir, 'projects', 'sample', 'saved.jsonl')
  const first = await readFile(path, 'utf8')
  // The live Claude process would normally be the one appending; a line here stands in for that, local-only
  // content the export must never remove or reorder.
  await writeFile(path, `${first}{"type":"user","uuid":"local-only"}\n`)
  await exportSessionToLocal(store, { configDir: dir, ...key })
  expect((await readFile(path, 'utf8')).trim().split('\n')).toEqual([
    '{"type":"user","uuid":"u1"}',
    '{"type":"user","uuid":"local-only"}',
  ])
})

it('matches entries with no uuid by their content, so a repeat export never duplicates one', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'saved' }
  await store.append(key, [{ type: 'system', content: 'no uuid here' }])
  await exportSessionToLocal(store, { configDir: dir, ...key })
  await exportSessionToLocal(store, { configDir: dir, ...key })
  const path = join(dir, 'projects', 'sample', 'saved.jsonl')
  expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
})

it('rejects an unreadable existing file and a write it cannot make, rather than guess', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'saved' }
  await store.append(key, [{ type: 'user', uuid: 'u1' }])
  await mkdir(join(dir, 'projects', 'sample'), { recursive: true })
  await writeFile(join(dir, 'projects', 'sample', 'saved.jsonl'), 'not valid JSON\n')
  await expect(exportSessionToLocal(store, { configDir: dir, ...key })).rejects.toThrow()
  await rm(join(dir, 'projects'), { recursive: true, force: true })
  // A file sits where the export needs a directory: the read of a not-yet-existing file is fine (ENOTDIR, not
  // ENOENT, so it isn't mistaken for "nothing exported yet"), and the following mkdir would fail the same way.
  await writeFile(join(dir, 'projects'), 'not a directory')
  await expect(exportSessionToLocal(store, { configDir: dir, ...key })).rejects.toThrow()
})

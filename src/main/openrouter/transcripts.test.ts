import { afterAll, afterEach, expect, it } from 'vitest'
import { openTestDatabase, sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { hasTranscript, sqliteSessionStore } from './transcripts'

const database = openTestDatabase()
afterAll(() => {
  database.close()
})
afterEach(() => {
  database.db.prepare('DELETE FROM sdk_transcripts').run()
})

it('round-trips complete opaque history, scopes child transcripts and upserts stable UUIDs', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample-project', sessionId: 'session-1' }
  expect(await store.load(key)).toBeNull()
  expect(hasTranscript(database.db, key.sessionId)).toBe(false)
  await store.append(key, [{ type: 'title', title: 'Sample task' }])
  expect(hasTranscript(database.db, key.sessionId)).toBe(false)
  await store.append(key, [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Remember the sample code.' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'thinking', thinking: 'Inspect the file.', signature: 'sample-signature' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/code/sample.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'export const answer = 42' }] },
    },
    { type: 'metadata', nested: { list: [1, null, true] } },
  ])
  await store.append(key, [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Updated sample instruction.' } },
    { type: 'assistant', uuid: 'a2' },
    { type: 'assistant', uuid: 'a2', final: true },
  ])
  await store.append({ ...key, subpath: 'subagents/child-1' }, [{ type: 'assistant', uuid: 'a1', child: true }])
  const loaded = await store.load(key)
  expect(loaded).toHaveLength(6)
  expect(loaded?.[1]?.message).toEqual({ role: 'user', content: 'Updated sample instruction.' })
  expect(loaded?.[2]?.message).toMatchObject({
    content: [
      { type: 'thinking', signature: 'sample-signature' },
      { type: 'tool_use', id: 'read-1' },
    ],
  })
  expect(loaded?.at(-1)).toMatchObject({ final: true })
  expect(await store.listSubkeys?.(key)).toEqual(['subagents/child-1'])
  expect(await store.load({ ...key, subpath: 'subagents/child-1' })).toEqual([
    { type: 'assistant', uuid: 'a1', child: true },
  ])
  expect(await store.load({ ...key, projectKey: 'another-project' })).toBeNull()
  expect(hasTranscript(database.db, key.sessionId)).toBe(true)
})

it('rejects malformed transcript entries rather than resuming with incomplete history', () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'broken' }
  database.db
    .prepare(
      "INSERT INTO sdk_transcripts (owner, project_key, session_id, subpath, entry_key, ordinal, entry) VALUES ('', ?, ?, ?, 'broken', 0, ?)",
    )
    .run('sample', 'broken', '', '{"type":3}')
  expect(() => store.load(key)).toThrow()
})

it('isolates tasks that resume the same SDK session', async () => {
  const workspace = sampleWorkspace(database.db)
  const first = sampleTask(database.db, workspace.id)
  const second = sampleTask(database.db, workspace.id)
  const key = { projectKey: 'sample', sessionId: 'shared-session' }
  const firstStore = sqliteSessionStore(database.db, first.id)
  const secondStore = sqliteSessionStore(database.db, second.id)
  await firstStore.append(key, [{ type: 'user', uuid: 'same-uuid', message: 'First task' }])
  expect(hasTranscript(database.db, key.sessionId, first.id)).toBe(true)
  expect(hasTranscript(database.db, key.sessionId, second.id)).toBe(false)
  await secondStore.append(key, [{ type: 'user', uuid: 'same-uuid', message: 'Second task' }])
  expect(await firstStore.load(key)).toEqual([{ type: 'user', uuid: 'same-uuid', message: 'First task' }])
  expect(await secondStore.load(key)).toEqual([{ type: 'user', uuid: 'same-uuid', message: 'Second task' }])
  expect(await sqliteSessionStore(database.db).load(key)).toBeNull()
})

it('writes only the incoming delta when the history is long', async () => {
  const store = sqliteSessionStore(database.db)
  const key = { projectKey: 'sample', sessionId: 'long-session' }
  await store.append(
    key,
    Array.from({ length: 2000 }, (_, index) => ({
      type: 'user',
      uuid: `u${String(index)}`,
      message: 'Sample history',
    })),
  )
  database.db.exec(`CREATE TEMP TABLE transcript_writes (count INTEGER);
    INSERT INTO transcript_writes VALUES (0);
    CREATE TEMP TRIGGER count_transcript_inserts AFTER INSERT ON sdk_transcripts BEGIN
      UPDATE transcript_writes SET count = count + 1;
    END;
    CREATE TEMP TRIGGER count_transcript_updates AFTER UPDATE ON sdk_transcripts BEGIN
      UPDATE transcript_writes SET count = count + 1;
    END;`)
  try {
    await store.append(key, [{ type: 'assistant', uuid: 'last', message: 'New reply' }])
    expect(database.db.prepare('SELECT count FROM transcript_writes').get()).toEqual({ count: 1 })
    expect(await store.load(key)).toHaveLength(2001)
  } finally {
    database.db.exec(
      'DROP TRIGGER count_transcript_inserts; DROP TRIGGER count_transcript_updates; DROP TABLE transcript_writes;',
    )
  }
})

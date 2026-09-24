// Child process for database.crash.test.ts. Opens the database at argv[2], commits one row, then starts a transaction
// big enough to spill pages into the WAL file, tells the parent it is mid-transaction, and waits to be killed.
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

const file = process.argv[2]
const db = new Database(file)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
// A small page cache, so the uncommitted pages spill to the WAL file before the kill instead of staying in memory.
db.pragma('cache_size = 50')

const insert = db.prepare('INSERT INTO note (body) VALUES (?)')
insert.run('committed')

db.exec('BEGIN')
const body = 'uncommitted '.repeat(100)
for (let i = 0; i < 10_000; i++) insert.run(body)
if (!db.inTransaction) throw new Error('expected to be mid-transaction')

// Wait to be killed. The timer must keep `db` reachable: once this module finishes evaluating nothing else refers to
// it, and a garbage-collected connection is closed by its finalizer, which rolls the transaction back and deletes the
// WAL file, so the kill would no longer land mid-write.
setInterval(() => db.inTransaction, 60_000)

// Collect garbage (the parent runs this with --expose-gc) once the module has finished evaluating, then report, so a
// connection that isn't kept alive fails every time rather than only when a collection happens to run. This callback
// must not refer to `db` itself, or it would keep the connection alive while it runs.
setImmediate(() => {
  globalThis.gc()
  if (!existsSync(`${file}-wal`)) throw new Error('the connection closed before the kill')
  process.stdout.write('mid-transaction\n')
})

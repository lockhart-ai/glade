// Child process for database.crash.test.ts. Opens the database at argv[2], commits one row, then starts a transaction
// big enough to spill pages into the WAL file, tells the parent it is mid-transaction, and waits to be killed.
import Database from 'better-sqlite3'

const db = new Database(process.argv[2])
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
// A small page cache, so the uncommitted pages spill to the WAL file before the kill instead of staying in memory.
db.pragma('cache_size = 50')

const insert = db.prepare('INSERT INTO note (body) VALUES (?)')
insert.run('committed')

db.exec('BEGIN')
const body = 'uncommitted '.repeat(100)
for (let i = 0; i < 10_000; i++) insert.run(body)
process.stdout.write('mid-transaction\n')

setInterval(() => undefined, 60_000)

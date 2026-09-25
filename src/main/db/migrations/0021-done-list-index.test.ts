import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { doneListIndexMigration } from './0021-done-list-index'

it('is migration 21', () => {
  expect(MIGRATIONS[20]).toBe(doneListIndexMigration)
})

it('indexes the tasks in the order the Done section lists them', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 20))

  migrate(db, MIGRATIONS)

  const columns = db.prepare("SELECT name, desc FROM pragma_index_xinfo('tasks_done_list') WHERE key = 1").all()
  expect(columns).toEqual([
    { name: 'workspace_id', desc: 0 },
    { name: 'state', desc: 0 },
    { name: 'pinned', desc: 0 },
    { name: 'updated_at', desc: 1 },
    { name: 'id', desc: 0 },
  ])
  db.close()
})

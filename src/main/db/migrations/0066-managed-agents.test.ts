import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { sampleTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'

it.each(['absent', 'without-config', 'current'])(
  'upgrades %s preview tables and cascades child history with its task',
  (schema) => {
    const db = openDatabase(':memory:')
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version <= 65),
    )
    const task = sampleTask(db, sampleWorkspace(db).id)
    if (schema !== 'current') {
      db.exec('DROP TABLE openrouter_usage; DROP TABLE sdk_transcript_failures;')
      if (schema === 'without-config')
        db.exec(`CREATE TABLE sdk_transcript_failures (
      owner TEXT, session_id TEXT, task_id TEXT, reason TEXT CHECK (reason = 'mirror_error'), PRIMARY KEY (owner, session_id)
    ); INSERT INTO sdk_transcript_failures VALUES ('', 'saved', NULL, 'mirror_error');`)
    }
    migrate(db, MIGRATIONS)
    if (schema === 'without-config')
      expect(db.prepare('SELECT reason, config_dir FROM sdk_transcript_failures').get()).toEqual({
        reason: 'mirror_error',
        config_dir: null,
      })
    db.prepare("INSERT INTO sdk_transcript_failures VALUES (?, 's', ?, 'importing', NULL)").run(task.id, task.id)
    db.prepare(
      "INSERT INTO managed_agents VALUES ('child', ?, 'dispatch', 'sonnet', 'session', 'completed', 'Done')",
    ).run(task.id)
    db.prepare("INSERT INTO sdk_transcript_backups VALUES (?, 's', ?, '[]')").run(task.id, task.id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    expect(db.prepare('SELECT * FROM managed_agents').all()).toEqual([])
    expect(db.prepare('SELECT * FROM sdk_transcript_backups').all()).toEqual([])
    expect(db.prepare('SELECT * FROM openrouter_usage').all()).toEqual([])
    db.close()
  },
)

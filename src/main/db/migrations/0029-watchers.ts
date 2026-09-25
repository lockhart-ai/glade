import type { Migration } from '../migrate'

/**
 * Adds the watchers: what each task's agent left running or scheduled with the SDK's own tools (a `Monitor`, a
 * background command, a `ScheduleWakeup`, a `CronCreate` job), for the Watchers tab. One per tool call that started
 * one. `sdk_id` is the SDK's id for it (its task's, or its job's), to match what the SDK reports later; a wakeup's is
 * only known once its turn ends. `stopped_by_you` marks one you stopped: a job you stopped is still in the SDK's
 * session, and its fires are turned away (`docs/sdk-notes.md` §13). A watcher goes with its task.
 */
export const watchersMigration: Migration = {
  version: 29,
  name: 'Add the watchers',
  up(db) {
    db.exec(`
      CREATE TABLE watchers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('monitor', 'command', 'wakeup', 'cron')),
        tool_use_id TEXT NOT NULL,
        sdk_id TEXT,
        label TEXT NOT NULL,
        detail TEXT NOT NULL,
        cron TEXT,
        schedule TEXT,
        recurring INTEGER NOT NULL CHECK (recurring IN (0, 1)),
        state TEXT NOT NULL
          CHECK (state IN ('running', 'scheduled', 'suspended', 'finished', 'failed', 'stopped')),
        wakes INTEGER NOT NULL DEFAULT 0,
        last_woke_at INTEGER,
        last_output TEXT,
        next_due_at INTEGER,
        expires_at INTEGER,
        outcome TEXT,
        stopped_by_you INTEGER NOT NULL DEFAULT 0 CHECK (stopped_by_you IN (0, 1)),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        UNIQUE (task_id, tool_use_id)
      ) STRICT;

      CREATE INDEX watchers_task ON watchers (task_id, started_at);
      CREATE INDEX watchers_live ON watchers (state) WHERE state IN ('running', 'scheduled', 'suspended');
    `)
  },
}

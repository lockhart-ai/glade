import type { Migration } from '../migrate'

/**
 * Adds the models the SDK offers (`ModelChoice` in `src/shared/models.ts`): the list the latest session reported, one
 * row per model in the SDK's order, so the pickers offer it before any session runs, and offline. `efforts` is the
 * model's effort levels, a JSON array, empty for a model that takes none. No rows until a session first reports it.
 *
 * Adds the `xhigh` effort to tasks, which the SDK's models support. SQLite can't change the effort's CHECK constraint,
 * so `tasks` is rebuilt, as migration 10 did: copied into a new table with the new constraint, then swapped in, with
 * foreign keys off (`rebuildsReferencedTable`). The old table's indexes and triggers go with it, so they're made
 * again (the search triggers, `SEARCH_TRIGGERS`). Every existing task keeps its effort.
 */
export const sdkModelsMigration: Migration = {
  version: 31,
  name: 'Add the SDK models and the xhigh effort',
  rebuildsReferencedTable: true,
  up(db) {
    db.exec(`
      CREATE TABLE sdk_models (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        resolved_model TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        efforts TEXT NOT NULL CHECK (json_valid(efforts) AND json_type(efforts) = 'array')
      ) STRICT;

      -- The trigger on messages reads tasks: it goes while tasks is swapped, or the rename fails on it.
      DROP TRIGGER messages_search_after_insert;

      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'done')),
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        session_id TEXT,
        activity TEXT NOT NULL DEFAULT 'waiting' CHECK (activity IN ('waiting', 'working', 'error', 'paused')),
        status_updated_at INTEGER,
        context_used_tokens INTEGER NOT NULL DEFAULT 0,
        context_window_tokens INTEGER,
        error TEXT CHECK (error IS NULL OR (json_valid(error) AND json_type(error) = 'object')),
        retrying TEXT CHECK (retrying IS NULL OR (json_valid(retrying) AND json_type(retrying) = 'object')),
        pause TEXT CHECK (pause IS NULL OR (json_valid(pause) AND json_type(pause) = 'object')),
        permission_mode TEXT NOT NULL DEFAULT 'allow_all' CHECK (permission_mode IN ('allow_all', 'ask_before_edits')),
        imported_at INTEGER,
        todos TEXT CHECK (todos IS NULL OR (json_valid(todos) AND json_type(todos) = 'object')),
        todos_stale INTEGER NOT NULL DEFAULT 0 CHECK (todos_stale IN (0, 1)),
        -- A task has a done time exactly when it's done.
        CHECK ((state = 'done') = (done_at IS NOT NULL))
      ) STRICT;

      INSERT INTO tasks_new (id, workspace_id, title, objective, status, state, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id, activity, status_updated_at, context_used_tokens,
        context_window_tokens, error, retrying, pause, permission_mode, imported_at, todos, todos_stale)
      SELECT id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at,
        done_at, session_id, activity, status_updated_at, context_used_tokens, context_window_tokens, error, retrying,
        pause, permission_mode, imported_at, todos, todos_stale
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX tasks_by_workspace ON tasks (workspace_id, updated_at);
      CREATE INDEX tasks_done_list ON tasks (workspace_id, state, pinned, updated_at DESC, id);
      CREATE UNIQUE INDEX tasks_session_id ON tasks (session_id) WHERE session_id IS NOT NULL;

      CREATE TRIGGER tasks_search_after_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO search_documents (task_id, workspace_id, field, body) VALUES
          (new.id, new.workspace_id, 'title', new.title),
          (new.id, new.workspace_id, 'objective', new.objective),
          (new.id, new.workspace_id, 'status', new.status);
      END;
      CREATE TRIGGER tasks_search_after_title AFTER UPDATE OF title ON tasks WHEN old.title IS NOT new.title BEGIN
        UPDATE search_documents SET body = new.title WHERE task_id = new.id AND field = 'title';
      END;
      CREATE TRIGGER tasks_search_after_objective AFTER UPDATE OF objective ON tasks
        WHEN old.objective IS NOT new.objective BEGIN
        UPDATE search_documents SET body = new.objective WHERE task_id = new.id AND field = 'objective';
      END;
      CREATE TRIGGER tasks_search_after_status AFTER UPDATE OF status ON tasks WHEN old.status IS NOT new.status BEGIN
        UPDATE search_documents SET body = new.status WHERE task_id = new.id AND field = 'status';
      END;
      CREATE TRIGGER messages_search_after_insert AFTER INSERT ON messages BEGIN
        INSERT INTO search_documents (task_id, workspace_id, field, message_id, body)
        SELECT new.task_id, tasks.workspace_id, 'message', new.id, new.body FROM tasks WHERE tasks.id = new.task_id;
      END;
    `)
  },
}

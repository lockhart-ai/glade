import type { Migration } from '../migrate'

/** The triggers that keep `search_documents` in step with `tasks` and `messages`. */
export const SEARCH_TRIGGERS = [
  'search_documents_after_insert',
  'search_documents_after_delete',
  'search_documents_after_update',
  'tasks_search_after_insert',
  'tasks_search_after_title',
  'tasks_search_after_objective',
  'tasks_search_after_status',
  'messages_search_after_insert',
] as const

/**
 * The full-text search index (`search.query`): every task's title, objective and status (its outcome once done), and
 * every chat message, yours and the agent's, each a row of `search_documents` with the task and workspace it belongs
 * to. `search_fts` is an FTS5 index over their text, with `search_documents` as its external content, so snippets are
 * read from there. Its `unicode61` tokenizer folds case and diacritics.
 *
 * Triggers keep it in step: a new task adds its three fields (blank ones too, so an update only ever rewrites a row),
 * a change to one rewrites that row, and a new message adds its row. Deleting a task or a message deletes its rows by
 * cascade, and `search_documents`' own triggers carry every insert, update and delete into `search_fts`. Existing tasks
 * and messages are indexed here.
 *
 * A later migration that rebuilds `tasks` or `messages` drops their triggers with the old table, so it must create
 * them again (`SEARCH_TRIGGERS` lists them; a test checks the latest schema has them all).
 */
export const searchIndexMigration: Migration = {
  version: 16,
  name: 'Index tasks and messages for search',
  up(db) {
    db.exec(`
      CREATE TABLE search_documents (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        field TEXT NOT NULL CHECK (field IN ('title', 'objective', 'status', 'message')),
        message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        -- A message's row names it; a task field's doesn't.
        CHECK ((field = 'message') = (message_id IS NOT NULL))
      ) STRICT;

      -- For the triggers' lookups, and for the cascades from tasks and messages.
      CREATE INDEX search_documents_by_task ON search_documents (task_id, field);
      CREATE INDEX search_documents_by_message ON search_documents (message_id);

      CREATE VIRTUAL TABLE search_fts USING fts5 (
        body,
        content = 'search_documents',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER search_documents_after_insert AFTER INSERT ON search_documents BEGIN
        INSERT INTO search_fts (rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER search_documents_after_delete AFTER DELETE ON search_documents BEGIN
        INSERT INTO search_fts (search_fts, rowid, body) VALUES ('delete', old.id, old.body);
      END;
      CREATE TRIGGER search_documents_after_update AFTER UPDATE OF body ON search_documents BEGIN
        INSERT INTO search_fts (search_fts, rowid, body) VALUES ('delete', old.id, old.body);
        INSERT INTO search_fts (rowid, body) VALUES (new.id, new.body);
      END;

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

      INSERT INTO search_documents (task_id, workspace_id, field, body)
        SELECT id, workspace_id, 'title', title FROM tasks
        UNION ALL SELECT id, workspace_id, 'objective', objective FROM tasks
        UNION ALL SELECT id, workspace_id, 'status', status FROM tasks;
      INSERT INTO search_documents (task_id, workspace_id, field, message_id, body)
        SELECT messages.task_id, tasks.workspace_id, 'message', messages.id, messages.body
        FROM messages JOIN tasks ON tasks.id = messages.task_id
        ORDER BY messages.task_id, messages.seq;
    `)
  },
}

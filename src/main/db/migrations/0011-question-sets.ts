import type { Migration } from '../migrate'

/**
 * Adds the questions the agent asks (`ask`): one row per call, a question set (`QuestionSet` in `src/shared/domain.ts`),
 * which stays open until you answer it, so a question the app quit on is still open after a relaunch. Its questions
 * are a JSON array and your reply a JSON object, null until you answer; the question sets repository parses them. A
 * task has at most one open set, since its agent's turn waits on it.
 */
export const questionSetsMigration: Migration = {
  version: 11,
  name: 'Add the question sets',
  up(db) {
    db.exec(`
      CREATE TABLE question_sets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        turn INTEGER NOT NULL,
        questions TEXT NOT NULL CHECK (json_valid(questions) AND json_type(questions) = 'array'),
        state TEXT NOT NULL,
        reply TEXT CHECK (reply IS NULL OR (json_valid(reply) AND json_type(reply) = 'object')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      ) STRICT;
      CREATE INDEX question_sets_by_task ON question_sets (task_id, state);
    `)
  },
}

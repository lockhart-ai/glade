import type { Migration } from '../migrate'

/**
 * Adds each open question set's card draft (#615): what you've filled in on the card and not sent yet, so it's there
 * again when you come back to the task and after a relaunch, the way the input bar's draft is. It goes with the set —
 * the answers can only be sent to the set they were typed on — and so lives on its row as a JSON object, null while
 * the card is empty and nulled when the set is answered or withdrawn.
 */
export const questionCardDraftsMigration: Migration = {
  version: 76,
  name: 'Add the question card drafts',
  up(db) {
    db.exec(`
      ALTER TABLE question_sets ADD COLUMN draft TEXT
        CHECK (draft IS NULL OR (json_valid(draft) AND json_type(draft) = 'object'));
    `)
  },
}

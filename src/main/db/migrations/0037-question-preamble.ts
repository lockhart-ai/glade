import type { Migration } from '../migrate'

/**
 * Adds each question set's preamble (#298): what the agent said to you before its questions (`ask`'s `preamble`), its
 * reply to your message, shown at the top of the card. Null for a set asked without one, as every set asked before
 * this was.
 */
export const questionPreambleMigration: Migration = {
  version: 37,
  name: 'Add the question preamble',
  up(db) {
    db.exec(`ALTER TABLE question_sets ADD COLUMN preamble TEXT CHECK (preamble IS NULL OR preamble <> '')`)
  },
}

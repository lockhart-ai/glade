import type { Migration } from '../migrate'

/**
 * Adds single-file grants to the sandbox grants (P15-05, #450; `FolderGrant.file` in `src/shared/sandbox.ts`): a
 * permission card grants one file, and nothing beside it, when the file's folder is too much to offer (the home folder,
 * say). `is_file` is 1 for such a grant and 0 for a folder, as every grant made before this is; a domain's is 0.
 */
export const sandboxFileGrantsMigration: Migration = {
  version: 57,
  name: 'Add single-file sandbox grants',
  up(db) {
    db.exec(`
      ALTER TABLE sandbox_grants ADD COLUMN is_file INTEGER NOT NULL DEFAULT 0
        CHECK (is_file IN (0, 1) AND (kind = 'folder' OR is_file = 0));
    `)
  },
}

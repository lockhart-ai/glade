import type { Migration } from '../migrate'

/**
 * Adds what a permission request asks of the agent sandbox, and who its folder or domain was granted to (P15-05, #450;
 * `PermissionRequest.sandbox` and `grantedScope` in `src/shared/domain.ts`). `sandbox` is the request's `SandboxAsk`
 * as JSON: a folder with the access asked for, a domain, or running a command outside the sandbox; null for a request
 * that doesn't cross the sandbox's bounds, as every request made before this is. `granted_scope` is `task` or
 * `workspace` once you allow a folder or domain for one, and null otherwise.
 */
export const sandboxPermissionRequestsMigration: Migration = {
  version: 56,
  name: 'Add what a permission request asks of the sandbox, and who it was granted to',
  up(db) {
    db.exec(`
      ALTER TABLE permission_requests ADD COLUMN sandbox TEXT
        CHECK (sandbox IS NULL OR (json_valid(sandbox) AND json_type(sandbox) = 'object'));
      ALTER TABLE permission_requests ADD COLUMN granted_scope TEXT
        CHECK (granted_scope IS NULL OR granted_scope IN ('task', 'workspace'));
    `)
  },
}

import type { Migration } from '../migrate'

export const openRouterManagementMigration: Migration = {
  version: 68,
  name: 'Keep the OpenRouter management key and the guardrails it read',
  up(db) {
    // Null until a management key connects; the guardrail list is null while none is known (either no key, or none it
    // restricts), and then names the providers the key may use, filtering both provider lists.
    db.exec(`
      ALTER TABLE openrouter_connection ADD COLUMN encrypted_management_key BLOB;
      ALTER TABLE openrouter_connection ADD COLUMN guardrail_providers TEXT CHECK (guardrail_providers IS NULL OR json_valid(guardrail_providers));
    `)
  },
}

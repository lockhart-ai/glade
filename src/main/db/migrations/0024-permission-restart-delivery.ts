import type { Migration } from '../migrate'

/**
 * Carries a permission request the app quit on across the relaunch (`docs/decisions.md`, "Per-call permission
 * review"): its call is gone, so its decision goes to the agent in a message once every such request of its task is
 * decided, and the call the agent then makes again with the same input goes ahead once without asking. Each request
 * records how far that has got (`RestartDelivery` in `../repositories/permission-requests`): null for a request a call
 * waited on, `pending` for one the app quit on whose decision hasn't reached the agent, `delivered` once it has (an
 * allowed call may then run once without asking, until that turn ends), and `settled` once there's nothing left to do.
 */
export const permissionRestartDeliveryMigration: Migration = {
  version: 24,
  name: 'Add how far a permission request the app quit on has got',
  up(db) {
    db.exec(`
      ALTER TABLE permission_requests ADD COLUMN restart_delivery TEXT
        CHECK (restart_delivery IS NULL OR restart_delivery IN ('pending', 'delivered', 'settled'));
    `)
  },
}

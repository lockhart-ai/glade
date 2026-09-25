import type { Migration } from '../migrate'
import { schemaVersionMigration } from './0001-schema-version'
import { coreTablesMigration } from './0002-core-tables'
import { taskActivityMigration } from './0003-task-activity'
import { statusUpdatedAtMigration } from './0004-status-updated-at'
import { contextUsageMigration } from './0005-context-usage'
import { turnSummaryMigration } from './0006-turn-summary'
import { messageQueueMigration } from './0007-message-queue'
import { compactionMigration } from './0008-compaction'
import { taskErrorMigration } from './0009-task-error'
import { taskPauseMigration } from './0010-task-pause'
import { questionSetsMigration } from './0011-question-sets'
import { toolCallInterruptedMigration } from './0012-tool-call-interrupted'
import { subagentLogMigration } from './0013-subagent-log'
import { openFilesMigration } from './0014-open-files'
import { artifactsMigration } from './0015-artifacts'
import { searchIndexMigration } from './0016-search-index'
import { workspaceSelectionsMigration } from './0017-workspace-selections'
import { settingsMigration } from './0018-settings'
import { terminalTabsMigration } from './0019-terminal-tabs'
import { messageImagesMigration } from './0020-message-images'
import { doneListIndexMigration } from './0021-done-list-index'
import { permissionRequestsMigration } from './0022-permission-requests'
import { taskPermissionRulesMigration } from './0023-task-permission-rules'
import { permissionRestartDeliveryMigration } from './0024-permission-restart-delivery'
import { pluginsMigration } from './0025-plugins'

/** Every migration, in version order. Append new ones; never edit or reorder shipped ones. */
export const MIGRATIONS: readonly Migration[] = [
  schemaVersionMigration,
  coreTablesMigration,
  taskActivityMigration,
  statusUpdatedAtMigration,
  contextUsageMigration,
  turnSummaryMigration,
  messageQueueMigration,
  compactionMigration,
  taskErrorMigration,
  taskPauseMigration,
  questionSetsMigration,
  toolCallInterruptedMigration,
  subagentLogMigration,
  openFilesMigration,
  artifactsMigration,
  searchIndexMigration,
  workspaceSelectionsMigration,
  settingsMigration,
  terminalTabsMigration,
  messageImagesMigration,
  doneListIndexMigration,
  permissionRequestsMigration,
  taskPermissionRulesMigration,
  permissionRestartDeliveryMigration,
  pluginsMigration,
]

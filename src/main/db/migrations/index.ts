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
import { searchIndexMigration } from './0014-search-index'

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
  searchIndexMigration,
]

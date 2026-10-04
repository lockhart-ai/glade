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
import { importedSessionsMigration } from './0026-imported-sessions'
import { taskBackfillsMigration } from './0027-task-backfills'
import { inputDraftsMigration } from './0028-input-drafts'
import { taskTodosMigration } from './0029-task-todos'
import { watchersMigration } from './0030-watchers'
import { notificationsMigration } from './0031-notifications'
import { sdkModelsMigration } from './0032-sdk-models'
import { accountMigration } from './0033-account'
import { taskCommitsMigration } from './0034-task-commits'
import { watcherSubagentsMigration } from './0036-watcher-subagents'
import { questionPreambleMigration } from './0037-question-preamble'
import { subagentProgressMigration } from './0038-subagent-progress'
import { compactionFromSdkMigration } from './0039-compaction-from-sdk'
import { instructionUpdatesMigration } from './0040-instruction-updates'
import { artifactGroupsMigration } from './0041-artifact-groups'
import { usageReadingsMigration } from './0042-usage-readings'
import { terminalWorkspacesMigration } from './0043-terminal-workspaces'
import { refusalFallbackMigration } from './0044-refusal-fallback'
import { pastedBlocksMigration } from './0045-pasted-blocks'
import { attachedFilesMigration } from './0046-attached-files'
import { subagentTaskIdsMigration } from './0047-subagent-task-ids'
import { pluginGrantsMigration } from './0048-plugin-grants'
import { linkArtifactsMigration } from './0049-link-artifacts'
import { browseFoldersMigration } from './0050-browse-folders'
import { reportedContextWindowsMigration } from './0051-reported-context-windows'
import { runningToolCallsIndexMigration } from './0052-running-tool-calls-index'
import { pluginSettingsMigration } from './0053-plugin-settings'
import { sandboxGrantsMigration } from './0054-sandbox-grants'
import { broadcastMessagesMigration } from './0055-broadcast-messages'
import { sandboxPermissionRequestsMigration } from './0056-sandbox-permission-requests'
import { sandboxFileGrantsMigration } from './0057-sandbox-file-grants'
import { sessionSandboxContextMigration } from './0058-session-sandbox-context'
import { todoHubMigration } from './0059-todo-hub'

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
  importedSessionsMigration,
  taskBackfillsMigration,
  inputDraftsMigration,
  taskTodosMigration,
  watchersMigration,
  notificationsMigration,
  sdkModelsMigration,
  accountMigration,
  taskCommitsMigration,
  watcherSubagentsMigration,
  questionPreambleMigration,
  subagentProgressMigration,
  compactionFromSdkMigration,
  instructionUpdatesMigration,
  artifactGroupsMigration,
  usageReadingsMigration,
  terminalWorkspacesMigration,
  refusalFallbackMigration,
  pastedBlocksMigration,
  attachedFilesMigration,
  subagentTaskIdsMigration,
  pluginGrantsMigration,
  linkArtifactsMigration,
  browseFoldersMigration,
  reportedContextWindowsMigration,
  runningToolCallsIndexMigration,
  pluginSettingsMigration,
  sandboxGrantsMigration,
  broadcastMessagesMigration,
  sandboxPermissionRequestsMigration,
  sandboxFileGrantsMigration,
  sessionSandboxContextMigration,
  todoHubMigration,
]

/** The version a database is at once every migration has run: the last one's, which can skip versions still in flight. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0

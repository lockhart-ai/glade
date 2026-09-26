import type { Database } from 'better-sqlite3'
import { ArtifactDateGroup, type ArtifactGroupFold } from '../../../shared/domain'
import { Row } from './rows'

/** One of a task's artifact date groups opened or folded. */
export interface ArtifactGroupChange extends ArtifactGroupFold {
  readonly taskId: string
}

const GROUPS = Object.values(ArtifactDateGroup)

function parseFold(raw: unknown): ArtifactGroupFold {
  const row = new Row('artifact_groups', raw)
  return { group: row.oneOf('date_group', GROUPS), open: row.flag('open') }
}

/** Remembers whether one of a task's artifact date groups is open, replacing what was remembered for it. */
export function setArtifactGroupOpen(db: Database, { taskId, group, open }: ArtifactGroupChange): void {
  db.prepare(
    `INSERT INTO artifact_groups (task_id, date_group, open) VALUES (?, ?, ?)
    ON CONFLICT (task_id, date_group) DO UPDATE SET open = excluded.open`,
  ).run(taskId, group, open ? 1 : 0)
}

/** The artifact date groups of a task you opened or folded, newest group first. None you haven't touched. */
export function listArtifactGroups(db: Database, taskId: string): ArtifactGroupFold[] {
  const folds = db.prepare('SELECT date_group, open FROM artifact_groups WHERE task_id = ?').all(taskId).map(parseFold)
  return folds.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))
}

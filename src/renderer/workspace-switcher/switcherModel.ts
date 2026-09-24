import { needsYou } from '../../shared/attention'
import { TaskState, type Task, type Workspace } from '../../shared/domain'

/** What a workspace's row in the switcher says about its tasks. */
export enum WorkspaceStatusKind {
  /** Some of its tasks need you (purple): the one thing to act on, so it wins. */
  NeedsYou = 'needs_you',
  /** It has active tasks, none of which needs you. */
  Active = 'active',
  /** It has no active tasks. */
  Idle = 'idle',
}

export interface WorkspaceNeedsYou {
  readonly kind: WorkspaceStatusKind.NeedsYou
  /** How many of its tasks need you. */
  readonly count: number
}

export interface WorkspaceActive {
  readonly kind: WorkspaceStatusKind.Active
  /** How many of its tasks are active. */
  readonly count: number
}

export interface WorkspaceIdle {
  readonly kind: WorkspaceStatusKind.Idle
}

export type WorkspaceStatus = WorkspaceNeedsYou | WorkspaceActive | WorkspaceIdle

/**
 * A workspace's status in the switcher (`docs/design/html/14-workspace-switcher.html`): "N needs you" when any of its
 * tasks needs you, else "N active" for its active tasks, else idle.
 */
export function workspaceStatus(tasks: Iterable<Task>, workspaceId: string): WorkspaceStatus {
  let active = 0
  let needing = 0
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.state !== TaskState.Active) continue
    active += 1
    if (needsYou(task)) needing += 1
  }
  if (needing > 0) return { kind: WorkspaceStatusKind.NeedsYou, count: needing }
  if (active > 0) return { kind: WorkspaceStatusKind.Active, count: active }
  return { kind: WorkspaceStatusKind.Idle }
}

/** The status as the switcher words it. */
export function describeStatus(status: WorkspaceStatus): string {
  switch (status.kind) {
    case WorkspaceStatusKind.NeedsYou:
      return `${String(status.count)} needs you`
    case WorkspaceStatusKind.Active:
      return `${String(status.count)} active`
    case WorkspaceStatusKind.Idle:
      return 'idle'
  }
}

/** The colours a workspace's badge comes in, from the design, given out in turn by workspace. */
export enum BadgeTone {
  Blue = 'blue',
  Purple = 'purple',
  Teal = 'teal',
  Pink = 'pink',
}

const TONES: readonly BadgeTone[] = [BadgeTone.Blue, BadgeTone.Purple, BadgeTone.Teal, BadgeTone.Pink]

/** A workspace's badge colour: by its place among the workspaces, oldest first, so it never changes. */
export function badgeTone(workspaces: readonly Workspace[], workspaceId: string): BadgeTone {
  const index = Math.max(
    0,
    workspaces.findIndex(({ id }) => id === workspaceId),
  )
  return TONES[index % TONES.length] ?? BadgeTone.Blue
}

/** The first character of a name, upper-cased, for the badge; ? for no name. */
export function workspaceInitial(name: string): string {
  return (Array.from(name)[0] ?? '?').toUpperCase()
}

/**
 * The workspace ⌘1 – ⌘9 switch to: the nth, oldest first (the order the switcher lists them in), or undefined past the
 * last.
 */
export function workspaceAt(workspaces: readonly Workspace[], digit: number): Workspace | undefined {
  return digit >= 1 && digit <= 9 ? workspaces[digit - 1] : undefined
}

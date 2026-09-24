// A task's two states and the moves between them, as one small pure module. Mark done only when active; reopen only
// when done.
import { TaskState } from '../../shared/domain'

/** The ways a task moves between its two states. */
export enum TaskTransition {
  MarkDone = 'mark done',
  Reopen = 'reopen',
}

/** Why a transition was refused: the task isn't in the state it can leave that way. */
export interface InvalidTransition {
  readonly transition: TaskTransition
  readonly from: TaskState
  readonly message: string
}

export type TransitionResult =
  { readonly ok: true; readonly to: TaskState } | { readonly ok: false; readonly error: InvalidTransition }

function refuse(from: TaskState, transition: TaskTransition): TransitionResult {
  return { ok: false, error: { transition, from, message: `Can't ${transition} a task that is ${from}` } }
}

/** The state `transition` takes a task in state `from` to, or why it can't. */
export function applyTransition(from: TaskState, transition: TaskTransition): TransitionResult {
  switch (from) {
    case TaskState.Active:
      return transition === TaskTransition.MarkDone ? { ok: true, to: TaskState.Done } : refuse(from, transition)
    case TaskState.Done:
      return transition === TaskTransition.Reopen ? { ok: true, to: TaskState.Active } : refuse(from, transition)
  }
}

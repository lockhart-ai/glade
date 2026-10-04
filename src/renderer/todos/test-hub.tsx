// Test helpers for the todo hub: sample todos and children, and a store on the fake bridge with the hub turned on.
import { act } from '@testing-library/react'
import {
  ArtifactKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Artifact,
  type EpochMs,
  type FileArtifact,
  type LinkArtifact,
  type TaskCommit,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import {
  ChildKind,
  commitChildKey,
  FilingSource,
  type ChildRef,
  type Filing,
  type TodoId,
  type TodoPanel,
} from '../../shared/todoHub'
import { useGladeStore } from '../store/react'
import { sampleCommit, sampleWatcher, type FakeMain } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { TodoHub } from './TodoHub'

/** When the sample data is "now": 14:30 on 23 September 2026, local time. */
export const HUB_NOW = new Date(2026, 8, 23, 14, 30).getTime()

const MINUTE = 60_000

/** A time `minutes` before `HUB_NOW`. */
export function minutesAgo(minutes: number): EpochMs {
  return HUB_NOW - minutes * MINUTE
}

export function hubTodo(id: string | null, text: string, state = TodoState.Doing, fields: Partial<Todo> = {}): Todo {
  return { id, text, state, note: null, completedAt: state === TodoState.Done ? minutesAgo(2) : null, ...fields }
}

/** A file artifact of task `t1`, last changed `minutes` ago. */
export function hubFile(path: string, title: string, minutes = 5): FileArtifact {
  const at = minutesAgo(minutes)
  return {
    kind: ArtifactKind.File,
    taskId: 't1',
    path,
    title,
    addedAt: at,
    updatedAt: at,
    modifiedAt: at,
    missing: false,
  }
}

/** A link artifact of task `t1`, declared `minutes` ago. */
export function hubLink(url: string, title: string, minutes = 5): LinkArtifact {
  const at = minutesAgo(minutes)
  return { kind: ArtifactKind.Link, taskId: 't1', url, title, addedAt: at, updatedAt: at }
}

/** A subagent of task `t1`: its `Agent` call, started `minutes` ago and still running unless `fields` say otherwise. */
export function hubAgent(
  toolUseId: string,
  name: string,
  minutes = 5,
  fields: Partial<ToolCallEvent> = {},
): ToolCallEvent {
  return {
    id: `event-${toolUseId}`,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.ToolCall,
    name: 'Agent',
    input: { description: name, prompt: '…' },
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId,
    parentToolUseId: null,
    progressSummary: null,
    ...fields,
  }
}

/** A watcher of task `t1`, by the call that started it, started `minutes` ago. */
export function hubWatcher(toolUseId: string, minutes = 5, fields: Partial<Watcher> = {}): Watcher {
  return sampleWatcher(`watcher-${toolUseId}`, 't1', { toolUseId, startedAt: minutesAgo(minutes), ...fields })
}

/** A commit of task `t1`, made `minutes` ago. */
export function hubCommit(hash: string, subject: string, minutes = 5, fields: Partial<TaskCommit> = {}): TaskCommit {
  return sampleCommit(hash, 't1', { hash, subject, committedAt: minutesAgo(minutes), ...fields })
}

/** Which child each sample is. */
export const refOf = {
  file: (path: string): ChildRef => ({ kind: ChildKind.File, key: path }),
  link: (url: string): ChildRef => ({ kind: ChildKind.Link, key: url }),
  subagent: (toolUseId: string): ChildRef => ({ kind: ChildKind.Subagent, key: toolUseId }),
  commit: (commit: TaskCommit): ChildRef => ({ kind: ChildKind.Commit, key: commitChildKey(commit) }),
}

/** A child of task `t1` filed under a todo. */
export function hubFiling(ref: ChildRef, todoId: TodoId, filedAt = HUB_NOW): Filing {
  return { taskId: 't1', ...ref, todoId, source: FilingSource.Named, filedAt }
}

/** What task `t1` has, for a hub test; nothing of what's left out. */
export interface HubTask {
  readonly todos?: readonly Todo[]
  readonly artifacts?: readonly Artifact[]
  readonly toolEvents?: readonly ToolEvent[]
  readonly watchers?: readonly Watcher[]
  readonly commits?: readonly TaskCommit[]
  readonly filings?: readonly Filing[]
  readonly todoPanels?: readonly TodoPanel[]
}

/** The fake main's data for task `t1` with the hub on. */
export function hubMain(task: HubTask): Partial<FakeMain> {
  return {
    settings: { ...DEFAULT_SETTINGS, todoHubEnabled: true },
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ],
    ...(task.todos === undefined ? {} : { todos: { t1: { items: task.todos, updatedAt: minutesAgo(1) } } }),
    artifacts: [...(task.artifacts ?? [])],
    toolEvents: [...(task.toolEvents ?? [])],
    watchers: [...(task.watchers ?? [])],
    commits: [...(task.commits ?? [])],
    filings: [...(task.filings ?? [])],
    todoPanels: [...(task.todoPanels ?? [])],
    todoHubReads: [],
    watchedArtifacts: [],
    copied: [],
    opened: [],
  }
}

/** A store on the fake main, with the fake main's own data for a test to read and change. */
export interface HubStore extends StoreWrapper {
  readonly main: Partial<FakeMain>
}

/** A store on a fake main that has task `t1` as given, with the hub on, hydrated and with the task's logs loaded. */
export async function hubStore(task: HubTask): Promise<HubStore> {
  const main = hubMain(task)
  const wrapper = storeWrapper(main)
  await act(() => wrapper.store.getState().hydrate())
  return { ...wrapper, main }
}

/** The hub for task `t1`, with its todo list read from the store, as the right panel gives it. */
export function HubForTask(): React.JSX.Element {
  const list = useGladeStore((state) => state.todos.t1)
  return <TodoHub taskId="t1" list={list} />
}

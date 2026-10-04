import { describe, expect, it } from 'vitest'
import {
  ArtifactKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  WatcherKind,
  WatcherState,
  type Artifact,
  type TaskCommit,
  type Todo,
  type Watcher,
} from './domain'
import {
  childId,
  childIdNumber,
  childOfArtifact,
  childOfCommit,
  childOfSubagent,
  childOfWatcher,
  childrenOf,
  CHILD_KINDS,
  ChildFilter,
  ChildKind,
  commitChildKey,
  FilingSource,
  groupChildren,
  UNFILED_TODO_ID,
  type ChildRef,
  type Filing,
  type SubagentChild,
  type TaskChildren,
  type TodoChildren,
} from './todoHub'

const TASK = 'task-1'

function todo(id: string | null, text = `Todo ${String(id)}`): Todo {
  return { id, text, state: TodoState.Todo, note: null, completedAt: null }
}

function file(path: string, updatedAt = 1_000, modifiedAt: number | null = null): Artifact {
  return {
    kind: ArtifactKind.File,
    taskId: TASK,
    path,
    title: path,
    addedAt: 1_000,
    updatedAt,
    modifiedAt,
    missing: false,
  }
}

function link(url: string, updatedAt = 1_000): Artifact {
  return { kind: ArtifactKind.Link, taskId: TASK, url, title: url, addedAt: 1_000, updatedAt }
}

interface SubagentFields {
  /** The subagent that made it. */
  readonly madeBy?: string
  readonly state?: ToolCallState
  readonly lastActivityAt?: number
}

function subagent(id: string, { madeBy, state = ToolCallState.Done, lastActivityAt = 1_000 }: SubagentFields = {}) {
  const child: SubagentChild = {
    call: {
      id: `event-${id}`,
      taskId: TASK,
      turn: 1,
      createdAt: 1_000,
      kind: ToolEventKind.ToolCall,
      name: 'Agent',
      input: { description: `Subagent ${id}` },
      output: null,
      state,
      finishedAt: null,
      toolUseId: id,
      parentToolUseId: madeBy ?? null,
      progressSummary: null,
    },
    lastActivityAt,
  }
  return child
}

function watcher(toolUseId: string, fields: Partial<Watcher> = {}): Watcher {
  return {
    id: `watcher-${toolUseId}`,
    taskId: TASK,
    kind: WatcherKind.Monitor,
    toolUseId,
    parentToolUseId: null,
    label: 'CI on PR #511',
    detail: 'gh pr checks 511 --watch',
    schedule: null,
    recurring: true,
    state: WatcherState.Finished,
    wakes: 0,
    lastWokeAt: null,
    lastOutput: null,
    nextDueAt: null,
    expiresAt: null,
    outcome: null,
    startedAt: 1_000,
    endedAt: 2_000,
    ...fields,
  }
}

function commit(hash: string, fields: Partial<TaskCommit> = {}): TaskCommit {
  return {
    id: `commit-${hash}`,
    taskId: TASK,
    hash,
    subject: 'Fix the date helpers',
    branch: 'main',
    committedAt: 1_000,
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    merge: false,
    repoPath: '/code/acme-api',
    subagentToolUseId: null,
    ...fields,
  }
}

function filing(ref: ChildRef, todoId: string, source = FilingSource.Named, filedAt = 5_000): Filing {
  return { taskId: TASK, ...ref, todoId, source, filedAt }
}

const FILE = (path: string): ChildRef => ({ kind: ChildKind.File, key: path })
const LINK = (url: string): ChildRef => ({ kind: ChildKind.Link, key: url })
const SUBAGENT = (id: string): ChildRef => ({ kind: ChildKind.Subagent, key: id })
const WATCHER = (id: string): ChildRef => ({ kind: ChildKind.Watcher, key: id })
const COMMIT = (hash: string, repoPath = '/code/acme-api'): ChildRef => ({
  kind: ChildKind.Commit,
  key: commitChildKey({ hash, repoPath }),
})

function group(children: Partial<TaskChildren>) {
  return groupChildren({ todos: [], artifacts: [], subagents: [], watchers: [], commits: [], filings: [], ...children })
}

/** A group's children as `kind key`, in its order. */
function refs({ children }: TodoChildren): string[] {
  return children.map(({ kind, key }) => `${kind} ${key}`)
}

/** Which group has each child: `kind key` to the todo's id. */
function places(children: Partial<TaskChildren>): Record<string, string> {
  const { todos, unfiled } = group(children)
  return Object.fromEntries([...todos, unfiled].flatMap((each) => refs(each).map((ref) => [ref, each.todoId])))
}

describe('a child’s key', () => {
  it('is an artifact’s path or URL, by its kind', () => {
    expect(childOfArtifact(file('docs/plan.md'))).toEqual(FILE('docs/plan.md'))
    expect(childOfArtifact(link('https://example.com/pr/511'))).toEqual(LINK('https://example.com/pr/511'))
  })

  it('is a commit’s hash and the working tree it was made in, so one hash in two repositories is two children', () => {
    expect(commitChildKey({ hash: 'abc123', repoPath: '/code/acme-api' })).toBe('abc123 /code/acme-api')
    expect(COMMIT('abc123', '/code/acme-api').key).not.toBe(COMMIT('abc123', '/code/acme-web').key)
  })

  it('is the id of the call that started a subagent or a watcher, each in its own kind', () => {
    expect(childOfSubagent(subagent('toolu_1').call)).toEqual(SUBAGENT('toolu_1'))
    expect(childOfWatcher(watcher('toolu_1'))).toEqual(WATCHER('toolu_1'))
    expect(childOfCommit(commit('abc123'))).toEqual(COMMIT('abc123'))
  })

  it('has a filter for every kind, by the kind’s own name, and one for all', () => {
    expect(Object.values(ChildFilter)).toEqual([ChildFilter.All, ...CHILD_KINDS])
  })
})

describe('a child’s short id', () => {
  it('is c and its number, and reads back to the number', () => {
    expect(childId(1)).toBe('c1')
    expect(childId(204)).toBe('c204')
    for (const number of [1, 9, 10, 204, 1_000_000]) expect(childIdNumber(childId(number))).toBe(number)
  })

  it('is nothing else: no zero, no padding, no other letter, no spaces, no number too large to count', () => {
    const others = ['c0', 'c01', 'C1', 'c', '1', ' c1', 'c1 ', 'c-1', 'c1.5', 'c1e3', 'todo 1', '', 'c9007199254740993']
    for (const text of others) expect(childIdNumber(text), text).toBeNull()
  })
})

describe('childrenOf', () => {
  it('lists every child once: artifacts, subagents and watchers as they come, then commits oldest first', () => {
    expect(
      childrenOf({
        artifacts: [link('https://example.com/pr/511'), file('docs/plan.md')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        watchers: [watcher('watch-a')],
        // As the Changes tab lists them: newest first.
        commits: [commit('newest', { committedAt: 9_000 }), commit('oldest', { committedAt: 1_000 })],
      }),
    ).toEqual([
      LINK('https://example.com/pr/511'),
      FILE('docs/plan.md'),
      SUBAGENT('agent-a'),
      SUBAGENT('agent-b'),
      WATCHER('watch-a'),
      COMMIT('oldest'),
      COMMIT('newest'),
    ])
    expect(childrenOf({ artifacts: [], subagents: [], watchers: [], commits: [] })).toEqual([])
  })

  it('leaves the commits it was given in their order', () => {
    const commits = [commit('newest', { committedAt: 9_000 }), commit('oldest', { committedAt: 1_000 })]
    childrenOf({ artifacts: [], subagents: [], watchers: [], commits })
    expect(commits.map(({ hash }) => hash)).toEqual(['newest', 'oldest'])
  })
})

describe('groupChildren', () => {
  it('gives every todo that has an id a group, in the agent’s order, and one for the children under no todo', () => {
    const grouped = group({ todos: [todo('2'), todo('1'), todo('7')] })

    expect(grouped.todos.map(({ todoId }) => todoId)).toEqual(['2', '1', '7'])
    expect(grouped.unfiled.todoId).toBe(UNFILED_TODO_ID)
    for (const each of [...grouped.todos, grouped.unfiled]) {
      expect(each.children).toEqual([])
      expect(each.tallies).toEqual({
        [ChildKind.File]: { count: 0, live: false },
        [ChildKind.Link]: { count: 0, live: false },
        [ChildKind.Subagent]: { count: 0, live: false },
        [ChildKind.Watcher]: { count: 0, live: false },
        [ChildKind.Commit]: { count: 0, live: false },
      })
    }
  })

  it('puts each child under the todo its filing names, saying how it was filed', () => {
    const grouped = group({
      todos: [todo('1'), todo('2')],
      artifacts: [file('docs/plan.md'), link('https://example.com/pr/511')],
      subagents: [subagent('agent-a')],
      watchers: [watcher('watch-a')],
      commits: [commit('abc123')],
      filings: [
        filing(FILE('docs/plan.md'), '1'),
        filing(LINK('https://example.com/pr/511'), '2', FilingSource.Moved),
        filing(SUBAGENT('agent-a'), '2'),
        filing(WATCHER('watch-a'), '1', FilingSource.Moved),
        filing(COMMIT('abc123'), '2'),
      ],
    })

    const [first, second] = grouped.todos
    expect(first?.children.map(({ kind, key, source }) => [kind, key, source])).toEqual([
      [ChildKind.Watcher, 'watch-a', FilingSource.Moved],
      [ChildKind.File, 'docs/plan.md', FilingSource.Named],
    ])
    expect(second?.children.map(({ kind, key, source }) => [kind, key, source])).toEqual([
      [ChildKind.Link, 'https://example.com/pr/511', FilingSource.Moved],
      [ChildKind.Subagent, 'agent-a', FilingSource.Named],
      [ChildKind.Commit, 'abc123 /code/acme-api', FilingSource.Named],
    ])
    expect(grouped.unfiled.children).toEqual([])
  })

  it.each([FilingSource.Named, FilingSource.Asked, FilingSource.Moved])(
    'counts a filing that was %s as the child’s own: it stays put when its subagent is elsewhere',
    (source) => {
      const grouped = group({
        todos: [todo('1'), todo('2')],
        subagents: [subagent('agent-a')],
        watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' })],
        filings: [filing(SUBAGENT('agent-a'), '1'), filing(WATCHER('watch-a'), '2', source)],
      })

      expect(grouped.todos.map(refs)).toEqual([['subagent agent-a'], ['watcher watch-a']])
      expect(grouped.todos[1]?.children[0]?.source).toBe(source)
    },
  )

  it('puts a child with no filing in the placeholder group, with no source', () => {
    const grouped = group({
      todos: [todo('1')],
      artifacts: [file('docs/plan.md'), link('https://example.com/pr/511')],
      subagents: [subagent('agent-a')],
      watchers: [watcher('watch-a')],
      commits: [commit('abc123')],
    })

    expect(grouped.todos[0]?.children).toEqual([])
    expect(refs(grouped.unfiled).sort()).toEqual([
      'commit abc123 /code/acme-api',
      'file docs/plan.md',
      'link https://example.com/pr/511',
      'subagent agent-a',
      'watcher watch-a',
    ])
    expect(grouped.unfiled.children.every(({ source }) => source === null)).toBe(true)
  })

  it('shows a task that never wrote todos as the placeholder group alone', () => {
    const grouped = group({ artifacts: [file('docs/plan.md')], filings: [filing(FILE('docs/plan.md'), '1')] })

    expect(grouped.todos).toEqual([])
    expect(refs(grouped.unfiled)).toEqual(['file docs/plan.md'])
  })

  it('drops the children of a todo that was deleted to the placeholder, and brings them back if it returns', () => {
    const children = {
      artifacts: [file('docs/plan.md')],
      subagents: [subagent('agent-a')],
      watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' })],
      filings: [filing(FILE('docs/plan.md'), '2'), filing(SUBAGENT('agent-a'), '2')],
    }

    // Todo 2 is gone from the list: what was under it, and what its subagent made, has no todo.
    const after = group({ ...children, todos: [todo('1'), todo('3')] })
    expect(after.todos.map(({ children: under }) => under)).toEqual([[], []])
    expect(refs(after.unfiled).sort()).toEqual(['file docs/plan.md', 'subagent agent-a', 'watcher watch-a'])
    expect(after.unfiled.children.every(({ source }) => source === null)).toBe(true)

    // The filings are still there, so a list that has the todo again has its children again.
    expect(places({ ...children, todos: [todo('2')] })).toEqual({
      'file docs/plan.md': '2',
      'subagent agent-a': '2',
      'watcher watch-a': '2',
    })
  })

  it('gives a todo with no id (TodoWrite’s) no group: what names nothing can have nothing filed under it', () => {
    const grouped = group({
      todos: [todo(null, 'Copy the files'), todo('1'), todo(null, 'Check the copies')],
      artifacts: [file('docs/plan.md')],
    })

    expect(grouped.todos.map(({ todoId }) => todoId)).toEqual(['1'])
    expect(refs(grouped.unfiled)).toEqual(['file docs/plan.md'])
  })

  it('never crashes on two todos sharing an id: the first has the children, and there is one group', () => {
    const grouped = group({
      todos: [todo('1', 'First'), todo('1', 'Second'), todo('2')],
      artifacts: [file('docs/plan.md')],
      filings: [filing(FILE('docs/plan.md'), '1')],
    })

    expect(grouped.todos.map(({ todoId }) => todoId)).toEqual(['1', '2'])
    expect(refs(grouped.todos[0] ?? grouped.unfiled)).toEqual(['file docs/plan.md'])
  })

  it('keeps the placeholder’s reserved id for the placeholder, whatever a todo or a filing says', () => {
    const grouped = group({
      todos: [todo(UNFILED_TODO_ID), todo('1')],
      artifacts: [file('docs/plan.md'), file('docs/notes.md')],
      filings: [filing(FILE('docs/plan.md'), UNFILED_TODO_ID)],
    })

    expect(grouped.todos.map(({ todoId }) => todoId)).toEqual(['1'])
    expect(refs(grouped.unfiled).sort()).toEqual(['file docs/notes.md', 'file docs/plan.md'])
    expect(grouped.unfiled.children.every(({ source }) => source === null)).toBe(true)
  })

  it('counts a child filed twice once, under the todo its later filing names', () => {
    const artifacts = [file('docs/plan.md')]
    const todos = [todo('1'), todo('2')]
    const first = filing(FILE('docs/plan.md'), '1', FilingSource.Named, 5_000)
    const second = filing(FILE('docs/plan.md'), '2', FilingSource.Moved, 6_000)

    for (const filings of [
      [first, second],
      [second, first],
    ]) {
      const grouped = group({ todos, artifacts, filings })
      expect(grouped.todos.map(refs)).toEqual([[], ['file docs/plan.md']])
      expect(grouped.todos[1]?.children[0]?.source).toBe(FilingSource.Moved)
      expect(grouped.todos[1]?.tallies[ChildKind.File]).toEqual({ count: 1, live: false })
      expect(grouped.unfiled.children).toEqual([])
    }
    // Filed twice at the same moment: the one given last counts.
    const tied = filing(FILE('docs/plan.md'), '1', FilingSource.Moved, 6_000)
    expect(group({ todos, artifacts, filings: [second, tied] }).todos.map(refs)).toEqual([['file docs/plan.md'], []])
  })

  it('tells a file from a link, a subagent from a watcher, with the same key', () => {
    expect(
      places({
        todos: [todo('1'), todo('2')],
        artifacts: [file('same'), link('same')],
        subagents: [subagent('toolu_1')],
        watchers: [watcher('toolu_1')],
        filings: [filing(FILE('same'), '1'), filing(WATCHER('toolu_1'), '2')],
      }),
    ).toEqual({
      'file same': '1',
      'link same': UNFILED_TODO_ID,
      'subagent toolu_1': UNFILED_TODO_ID,
      'watcher toolu_1': '2',
    })
  })

  describe('what a subagent made', () => {
    it('follows the subagent: its watchers, its commits and its own subagents, each as a child of the todo', () => {
      const grouped = group({
        todos: [todo('1'), todo('2')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' }), watcher('watch-main')],
        commits: [commit('abc123', { subagentToolUseId: 'agent-a' }), commit('def456')],
        filings: [filing(SUBAGENT('agent-a'), '2')],
      })

      expect(grouped.todos[1]?.children.map(({ kind, key, source }) => [kind, key, source])).toEqual([
        [ChildKind.Watcher, 'watch-a', FilingSource.Inherited],
        [ChildKind.Subagent, 'agent-a', FilingSource.Named],
        [ChildKind.Subagent, 'agent-b', FilingSource.Inherited],
        [ChildKind.Commit, 'abc123 /code/acme-api', FilingSource.Inherited],
      ])
      // The watcher a subagent left running counts with the todo's watchers; the task's own stay where they were.
      expect(grouped.todos[1]?.tallies[ChildKind.Watcher].count).toBe(1)
      expect(refs(grouped.unfiled).sort()).toEqual(['commit def456 /code/acme-api', 'watcher watch-main'])
    })

    it('follows it from three levels deep', () => {
      expect(
        places({
          todos: [todo('1'), todo('2')],
          subagents: [
            subagent('level-1'),
            subagent('level-2', { madeBy: 'level-1' }),
            subagent('level-3', { madeBy: 'level-2' }),
          ],
          watchers: [watcher('watch-deep', { parentToolUseId: 'level-3' })],
          commits: [
            commit('abc123', { subagentToolUseId: 'level-3' }),
            commit('def456', { subagentToolUseId: 'level-2' }),
          ],
          filings: [filing(SUBAGENT('level-1'), '2')],
        }),
      ).toEqual({
        'subagent level-1': '2',
        'subagent level-2': '2',
        'subagent level-3': '2',
        'watcher watch-deep': '2',
        'commit abc123 /code/acme-api': '2',
        'commit def456 /code/acme-api': '2',
      })
    })

    it('follows it whatever order the subagents come in', () => {
      const subagents = [
        subagent('level-3', { madeBy: 'level-2' }),
        subagent('level-1'),
        subagent('level-2', { madeBy: 'level-1' }),
      ]
      expect(places({ todos: [todo('1')], subagents, filings: [filing(SUBAGENT('level-1'), '1')] })).toEqual({
        'subagent level-1': '1',
        'subagent level-2': '1',
        'subagent level-3': '1',
      })
    })

    it('stays where its own filing put it, and so does what it made in turn', () => {
      expect(
        places({
          todos: [todo('1'), todo('2'), todo('3')],
          subagents: [
            subagent('level-1'),
            subagent('level-2', { madeBy: 'level-1' }),
            subagent('level-3', { madeBy: 'level-2' }),
          ],
          watchers: [
            watcher('watch-own', { parentToolUseId: 'level-1' }),
            watcher('watch-deep', { parentToolUseId: 'level-3' }),
          ],
          filings: [
            filing(SUBAGENT('level-1'), '1'),
            filing(WATCHER('watch-own'), '3'),
            // The agent moved the second subagent: it takes its own subagent and that one's watcher along.
            filing(SUBAGENT('level-2'), '2', FilingSource.Moved),
          ],
        }),
      ).toEqual({
        'subagent level-1': '1',
        'watcher watch-own': '3',
        'subagent level-2': '2',
        'subagent level-3': '2',
        'watcher watch-deep': '2',
      })
    })

    it('comes along when its subagent is moved, apart from anything filed on its own', () => {
      const children = {
        todos: [todo('1'), todo('2'), todo('3')],
        artifacts: [file('docs/review.md')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' })],
        commits: [
          commit('abc123', { subagentToolUseId: 'agent-a' }),
          commit('def456', { subagentToolUseId: 'agent-b' }),
          commit('fed987', { subagentToolUseId: 'agent-a' }),
        ],
      }
      const own = [
        filing(COMMIT('fed987'), '3'),
        // Recorded as inherited when it was made: it still follows its subagent.
        filing(WATCHER('watch-a'), '1', FilingSource.Inherited),
        // An artifact has no subagent to follow, so its inherited filing is what places it.
        filing(FILE('docs/review.md'), '1', FilingSource.Inherited),
      ]

      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '1'), ...own] })).toEqual({
        'subagent agent-a': '1',
        'subagent agent-b': '1',
        'watcher watch-a': '1',
        'commit abc123 /code/acme-api': '1',
        'commit def456 /code/acme-api': '1',
        'commit fed987 /code/acme-api': '3',
        'file docs/review.md': '1',
      })
      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '2', FilingSource.Moved), ...own] })).toEqual({
        'subagent agent-a': '2',
        'subagent agent-b': '2',
        'watcher watch-a': '2',
        'commit abc123 /code/acme-api': '2',
        'commit def456 /code/acme-api': '2',
        'commit fed987 /code/acme-api': '3',
        'file docs/review.md': '1',
      })
    })

    it('goes to the placeholder with a subagent that has no todo, or whose todo is gone', () => {
      const children = {
        todos: [todo('1')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        watchers: [watcher('watch-b', { parentToolUseId: 'agent-b' })],
      }
      const unfiled = {
        'subagent agent-a': UNFILED_TODO_ID,
        'subagent agent-b': UNFILED_TODO_ID,
        'watcher watch-b': UNFILED_TODO_ID,
      }

      expect(places(children)).toEqual(unfiled)
      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '9')] })).toEqual(unfiled)
      // Its own filing still holds, though: a child filed under a todo that's there stays there.
      expect(places({ ...children, filings: [filing(WATCHER('watch-b'), '1')] })).toEqual({
        ...unfiled,
        'watcher watch-b': '1',
      })
      expect(group(children).unfiled.children.every(({ source }) => source === null)).toBe(true)
    })

    it('falls to the placeholder when its own filing names a todo that’s gone, even if its subagent has one', () => {
      expect(
        places({
          todos: [todo('1')],
          subagents: [subagent('agent-a')],
          watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' })],
          filings: [filing(SUBAGENT('agent-a'), '1'), filing(WATCHER('watch-a'), '9', FilingSource.Moved)],
        }),
      ).toEqual({ 'subagent agent-a': '1', 'watcher watch-a': UNFILED_TODO_ID })
    })

    it('is placed by its inherited filing when the subagent that made it isn’t known', () => {
      const children = {
        todos: [todo('1')],
        watchers: [watcher('watch-a', { parentToolUseId: 'agent-gone' })],
        commits: [commit('abc123', { subagentToolUseId: 'agent-gone' })],
      }

      expect(places(children)).toEqual({
        'watcher watch-a': UNFILED_TODO_ID,
        'commit abc123 /code/acme-api': UNFILED_TODO_ID,
      })
      const filings = [
        filing(WATCHER('watch-a'), '1', FilingSource.Inherited),
        filing(COMMIT('abc123'), '9', FilingSource.Inherited),
      ]
      expect(places({ ...children, filings })).toEqual({
        'watcher watch-a': '1',
        'commit abc123 /code/acme-api': UNFILED_TODO_ID,
      })
      expect(group({ ...children, filings }).todos[0]?.children[0]?.source).toBe(FilingSource.Inherited)
    })

    it('never loops on subagents that made each other: they have no todo to follow', () => {
      expect(
        places({
          todos: [todo('1')],
          subagents: [
            subagent('agent-a', { madeBy: 'agent-b' }),
            subagent('agent-b', { madeBy: 'agent-a' }),
            subagent('agent-c', { madeBy: 'agent-c' }),
          ],
          watchers: [watcher('watch-a', { parentToolUseId: 'agent-a' })],
        }),
      ).toEqual({
        'subagent agent-a': UNFILED_TODO_ID,
        'subagent agent-b': UNFILED_TODO_ID,
        'subagent agent-c': UNFILED_TODO_ID,
        'watcher watch-a': UNFILED_TODO_ID,
      })
    })
  })

  describe('a group’s counts', () => {
    it('count each kind, and flag a kind only while one of its children is live', () => {
      const grouped = group({
        todos: [todo('1')],
        artifacts: [file('a.md'), file('b.md'), link('https://example.com/pr/511')],
        subagents: [
          subagent('agent-a', { state: ToolCallState.Done }),
          subagent('agent-b', { state: ToolCallState.Running }),
          subagent('agent-c', { state: ToolCallState.Error }),
        ],
        watchers: [
          watcher('watch-a', { state: WatcherState.Finished }),
          watcher('watch-b', { state: WatcherState.Failed }),
        ],
        commits: [commit('abc123')],
        filings: [
          filing(FILE('a.md'), '1'),
          filing(FILE('b.md'), '1'),
          filing(LINK('https://example.com/pr/511'), '1'),
          filing(SUBAGENT('agent-a'), '1'),
          filing(SUBAGENT('agent-b'), '1'),
          filing(SUBAGENT('agent-c'), '1'),
          filing(WATCHER('watch-a'), '1'),
          filing(WATCHER('watch-b'), '1'),
          filing(COMMIT('abc123'), '1'),
        ],
      })

      expect(grouped.todos[0]?.tallies).toEqual({
        [ChildKind.File]: { count: 2, live: false },
        [ChildKind.Link]: { count: 1, live: false },
        [ChildKind.Subagent]: { count: 3, live: true },
        [ChildKind.Watcher]: { count: 2, live: false },
        [ChildKind.Commit]: { count: 1, live: false },
      })
      expect(grouped.todos[0]?.children.filter(({ live }) => live).map(({ key }) => key)).toEqual(['agent-b'])
    })

    it.each([
      [ToolCallState.Running, true],
      [ToolCallState.Done, false],
      [ToolCallState.Error, false],
      [ToolCallState.Paused, false],
      [ToolCallState.Interrupted, false],
    ])('count a %s subagent as live: %s', (state, live) => {
      expect(group({ subagents: [subagent('agent-a', { state })] }).unfiled.tallies[ChildKind.Subagent]).toEqual({
        count: 1,
        live,
      })
    })

    it.each([
      // Only a process that runs is live: a wakeup or a job that's merely scheduled isn't.
      [WatcherState.Running, true],
      [WatcherState.Scheduled, false],
      [WatcherState.Suspended, false],
      [WatcherState.Finished, false],
      [WatcherState.Failed, false],
      [WatcherState.Stopped, false],
    ])('count a %s watcher as live: %s', (state, live) => {
      expect(group({ watchers: [watcher('watch-a', { state })] }).unfiled.tallies[ChildKind.Watcher]).toEqual({
        count: 1,
        live,
      })
    })

    it('count the placeholder’s children the same way', () => {
      const { unfiled } = group({
        artifacts: [file('a.md')],
        watchers: [watcher('watch-a', { state: WatcherState.Running })],
      })

      expect(unfiled.tallies[ChildKind.File]).toEqual({ count: 1, live: false })
      expect(unfiled.tallies[ChildKind.Watcher]).toEqual({ count: 1, live: true })
      expect(unfiled.tallies[ChildKind.Commit]).toEqual({ count: 0, live: false })
    })
  })

  describe('a group’s order', () => {
    it('is by each child’s last update, newest first, whatever its kind', () => {
      const { unfiled } = group({
        artifacts: [
          // A file by when it last changed, or by when it was declared until Glade has looked at it.
          file('changed.md', 1_000, 7_000),
          file('unseen.md', 3_000, null),
          link('https://example.com/pr/511', 5_000),
        ],
        subagents: [subagent('agent-a', { lastActivityAt: 6_000 })],
        watchers: [
          // A watcher by its last wake, else its end, else its start.
          watcher('woke', { startedAt: 100, endedAt: 9_000, lastWokeAt: 8_000 }),
          watcher('ended', { startedAt: 100, endedAt: 4_000, lastWokeAt: null }),
          watcher('started', { startedAt: 2_000, endedAt: null, lastWokeAt: null, state: WatcherState.Running }),
        ],
        commits: [commit('abc123', { committedAt: 1_000 })],
      })

      expect(unfiled.children.map(({ key, updatedAt }) => [key, updatedAt])).toEqual([
        ['woke', 8_000],
        ['changed.md', 7_000],
        ['agent-a', 6_000],
        ['https://example.com/pr/511', 5_000],
        ['ended', 4_000],
        ['unseen.md', 3_000],
        ['started', 2_000],
        ['abc123 /code/acme-api', 1_000],
      ])
    })

    it('keeps children updated at the same moment in the order they came: files and links, subagents, watchers, commits', () => {
      const { unfiled } = group({
        artifacts: [link('https://example.com/pr/511'), file('a.md'), file('b.md')],
        subagents: [subagent('agent-b'), subagent('agent-a')],
        watchers: [watcher('watch-a', { endedAt: 1_000 })],
        commits: [commit('abc123')],
      })

      expect(refs(unfiled)).toEqual([
        'link https://example.com/pr/511',
        'file a.md',
        'file b.md',
        'subagent agent-b',
        'subagent agent-a',
        'watcher watch-a',
        'commit abc123 /code/acme-api',
      ])
    })
  })

  it('leaves what it was given alone', () => {
    const children: TaskChildren = {
      todos: [todo('1')],
      artifacts: [file('a.md', 1_000), file('b.md', 2_000)],
      subagents: [subagent('agent-a')],
      watchers: [watcher('watch-a')],
      commits: [commit('abc123')],
      filings: [filing(FILE('a.md'), '1'), filing(FILE('b.md'), '1')],
    }
    const before = structuredClone(children)

    groupChildren(children)

    expect(children).toEqual(before)
  })

  it('groups 100 todos with 50 children under one, and hundreds more spread over the rest, each child once', () => {
    const todos = Array.from({ length: 100 }, (_, index) => todo(String(index + 1)))
    const artifacts = Array.from({ length: 300 }, (_, index) => file(`docs/file-${String(index)}.md`, index))
    const subagents = Array.from({ length: 60 }, (_, index) =>
      subagent(`agent-${String(index)}`, {
        ...(index % 3 === 0 ? {} : { madeBy: `agent-${String(index - 1)}` }),
        lastActivityAt: index,
        state: index === 30 ? ToolCallState.Running : ToolCallState.Done,
      }),
    )
    const watchers = Array.from({ length: 60 }, (_, index) =>
      watcher(`watch-${String(index)}`, { parentToolUseId: `agent-${String(index)}`, endedAt: index }),
    )
    const commits = Array.from({ length: 80 }, (_, index) =>
      commit(`hash${String(index)}`, {
        subagentToolUseId: index < 60 ? `agent-${String(index)}` : null,
        committedAt: index,
      }),
    )
    const filings = [
      // Fifty files under todo 1, the rest of the files over todos 2 to 100.
      ...artifacts.map((artifact, index) =>
        filing(childOfArtifact(artifact), index < 50 ? '1' : String(2 + (index % 99))),
      ),
      // Each top-level subagent under a todo of its own, bringing its two nested ones and everything they made.
      ...subagents
        .filter(({ call }) => call.parentToolUseId === null)
        .map(({ call }, index) => filing(SUBAGENT(call.toolUseId), String(index + 2))),
    ]

    const grouped = group({ todos, artifacts, subagents, watchers, commits, filings })

    const all = [...grouped.todos, grouped.unfiled].flatMap(refs)
    expect(all).toHaveLength(300 + 60 + 60 + 80)
    expect(new Set(all).size).toBe(all.length)
    expect(grouped.todos).toHaveLength(100)
    expect(grouped.todos[0]?.tallies[ChildKind.File]).toEqual({ count: 50, live: false })
    expect(grouped.todos[0]?.children.map(({ updatedAt }) => updatedAt)).toEqual(
      Array.from({ length: 50 }, (_, index) => 49 - index),
    )
    // The subagent at index 30 runs, under the todo of the top-level one it came from (the eleventh, so todo 12).
    expect(grouped.todos[11]?.tallies[ChildKind.Subagent]).toEqual({ count: 3, live: true })
    expect(grouped.todos[11]?.tallies[ChildKind.Watcher].count).toBe(3)
    expect(grouped.todos.filter(({ tallies }) => tallies[ChildKind.Subagent].live)).toHaveLength(1)
    // Only the main agent's own commits have no todo.
    expect(refs(grouped.unfiled)).toHaveLength(20)
    for (const { children } of grouped.todos) {
      const times = children.map(({ updatedAt }) => updatedAt)
      expect(times).toEqual([...times].sort((a, b) => b - a))
    }
  })
})

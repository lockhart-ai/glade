import { describe, expect, it } from 'vitest'
import {
  ArtifactKind,
  DividerKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  type Artifact,
  type TaskCommit,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
} from './domain'
import {
  childId,
  childIdNumber,
  childOfArtifact,
  childOfCommit,
  childOfSubagent,
  childrenOf,
  CHILD_KINDS,
  ChildFilter,
  ChildKind,
  PRODUCED_KINDS,
  refKey,
  commitChildKey,
  FilingSource,
  groupChildren,
  subagentsOf,
  subagentTodo,
  subagentTodos,
  UNFILED_TODO_ID,
  type ChildRef,
  type Filing,
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
}

function subagent(id: string, { madeBy, state = ToolCallState.Done }: SubagentFields = {}): ToolCallEvent {
  return {
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
const COMMIT = (hash: string, repoPath = '/code/acme-api'): ChildRef => ({
  kind: ChildKind.Commit,
  key: commitChildKey({ hash, repoPath }),
})

function all(children: Partial<TaskChildren>): TaskChildren {
  return { todos: [], artifacts: [], subagents: [], commits: [], filings: [], ...children }
}

function group(children: Partial<TaskChildren>) {
  return groupChildren(all(children))
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

/** The todo each subagent works on, by its call's id. */
function working(children: Partial<TaskChildren>): Record<string, string> {
  return Object.fromEntries(subagentTodos(all(children)))
}

describe('a child’s key', () => {
  it('is an artifact’s path or URL, by its kind', () => {
    expect(childOfArtifact(file('docs/plan.md'))).toEqual(FILE('docs/plan.md'))
    expect(childOfArtifact(link('https://example.com/pr/511'))).toEqual(LINK('https://example.com/pr/511'))
  })

  it('is a commit’s hash and the working tree it was made in, so one hash in two repositories is two children', () => {
    expect(commitChildKey({ hash: 'abc123', repoPath: '/code/acme-api' })).toBe('abc123 /code/acme-api')
    expect(COMMIT('abc123', '/code/acme-api').key).not.toBe(COMMIT('abc123', '/code/acme-web').key)
    expect(childOfCommit(commit('abc123'))).toEqual(COMMIT('abc123'))
  })

  it('is the id of the call that started a subagent', () => {
    expect(childOfSubagent(subagent('toolu_1'))).toEqual(SUBAGENT('toolu_1'))
  })
})

describe('the kinds', () => {
  it('are a file, a link, a subagent and a commit: no watcher is one', () => {
    expect(CHILD_KINDS).toEqual(['file', 'link', 'subagent', 'commit'])
  })

  it('a todo shows are the three it produced, in the order its row counts them: never a subagent', () => {
    expect(PRODUCED_KINDS).toEqual([ChildKind.File, ChildKind.Link, ChildKind.Commit])
  })

  it('have a filter each, by the kind’s own name, and one for all: none for a subagent or a watcher', () => {
    expect(Object.values(ChildFilter)).toEqual([ChildFilter.All, ...PRODUCED_KINDS])
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
  it('lists every child once: artifacts and subagents as they come, then commits oldest first', () => {
    expect(
      childrenOf({
        artifacts: [link('https://example.com/pr/511'), file('docs/plan.md')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        // As the Changes tab lists them: newest first.
        commits: [commit('newest', { committedAt: 9_000 }), commit('oldest', { committedAt: 1_000 })],
      }),
    ).toEqual([
      LINK('https://example.com/pr/511'),
      FILE('docs/plan.md'),
      SUBAGENT('agent-a'),
      SUBAGENT('agent-b'),
      COMMIT('oldest'),
      COMMIT('newest'),
    ])
    expect(childrenOf({ artifacts: [], subagents: [], commits: [] })).toEqual([])
  })

  it('puts commits made in the same second in the order they were made, not the reverse', () => {
    // Newest first, as a task lists them: of two made in one second, the one linked last comes first.
    const commits = [
      commit('third', { committedAt: 5_000 }),
      commit('second', { committedAt: 5_000 }),
      commit('first', { committedAt: 5_000 }),
      commit('before', { committedAt: 1_000 }),
    ]

    expect(childrenOf({ artifacts: [], subagents: [], commits })).toEqual([
      COMMIT('before'),
      COMMIT('first'),
      COMMIT('second'),
      COMMIT('third'),
    ])
  })

  it('leaves the commits it was given in their order', () => {
    const commits = [commit('newest', { committedAt: 9_000 }), commit('oldest', { committedAt: 1_000 })]
    childrenOf({ artifacts: [], subagents: [], commits })
    expect(commits.map(({ hash }) => hash)).toEqual(['newest', 'oldest'])
  })
})

describe('a subagent’s todo', () => {
  it('is the todo it was started for, and its own subagents’, unless one names another', () => {
    const children = all({
      todos: [todo('1'), todo('2')],
      subagents: [
        subagent('agent-a'),
        subagent('agent-b', { madeBy: 'agent-a' }),
        subagent('agent-c', { madeBy: 'agent-b' }),
        subagent('agent-d', { madeBy: 'agent-a' }),
      ],
      filings: [filing(SUBAGENT('agent-a'), '1'), filing(SUBAGENT('agent-d'), '2')],
    })

    expect(subagentTodo(children, 'agent-a')).toBe('1')
    // Started by a subagent, it works on its parent's todo, however deep.
    expect(subagentTodo(children, 'agent-b')).toBe('1')
    expect(subagentTodo(children, 'agent-c')).toBe('1')
    // Unless its own call named another.
    expect(subagentTodo(children, 'agent-d')).toBe('2')
    expect(Object.fromEntries(subagentTodos(children))).toEqual({
      'agent-a': '1',
      'agent-b': '1',
      'agent-c': '1',
      'agent-d': '2',
    })
  })

  it('is none for a subagent nothing was recorded for, one whose todo is gone, and one that is not there', () => {
    const children = all({
      todos: [todo('1')],
      subagents: [subagent('agent-a'), subagent('agent-b'), subagent('agent-c', { madeBy: 'agent-b' })],
      // The last is for a call that never became a subagent: recorded before it would have existed.
      filings: [filing(SUBAGENT('agent-b'), '7'), filing(SUBAGENT('agent-z'), '1')],
    })

    expect(subagentTodo(children, 'agent-a')).toBeNull()
    expect(subagentTodo(children, 'agent-b')).toBeNull()
    expect(subagentTodo(children, 'agent-c')).toBeNull()
    expect(subagentTodo(children, 'agent-z')).toBeNull()
    expect(subagentTodos(children)).toEqual(new Map())
  })

  it('comes back when the todo it names is in the list again', () => {
    const children = { subagents: [subagent('agent-a')], filings: [filing(SUBAGENT('agent-a'), '2')] }

    expect(working({ ...children, todos: [todo('1'), todo('3')] })).toEqual({})
    expect(working({ ...children, todos: [todo('2')] })).toEqual({ 'agent-a': '2' })
  })

  it('is the one its later filing names, of two', () => {
    const subagents = [subagent('agent-a')]
    const todos = [todo('1'), todo('2')]
    const first = filing(SUBAGENT('agent-a'), '1', FilingSource.Named, 5_000)
    const second = filing(SUBAGENT('agent-a'), '2', FilingSource.Moved, 6_000)

    expect(working({ todos, subagents, filings: [first, second] })).toEqual({ 'agent-a': '2' })
    expect(working({ todos, subagents, filings: [second, first] })).toEqual({ 'agent-a': '2' })
  })

  it('follows its maker from three levels deep, whatever order the subagents come in', () => {
    const subagents = [
      subagent('level-3', { madeBy: 'level-2' }),
      subagent('level-1'),
      subagent('level-2', { madeBy: 'level-1' }),
    ]

    expect(working({ todos: [todo('1')], subagents, filings: [filing(SUBAGENT('level-1'), '1')] })).toEqual({
      'level-1': '1',
      'level-2': '1',
      'level-3': '1',
    })
  })

  it('stays where its own filing put it, and so does what it started in turn', () => {
    expect(
      working({
        todos: [todo('1'), todo('2')],
        subagents: [
          subagent('level-1'),
          subagent('level-2', { madeBy: 'level-1' }),
          subagent('level-3', { madeBy: 'level-2' }),
        ],
        filings: [
          filing(SUBAGENT('level-1'), '1'),
          // The agent gave the second another todo: its own subagent works on that one too.
          filing(SUBAGENT('level-2'), '2', FilingSource.Moved),
        ],
      }),
    ).toEqual({ 'level-1': '1', 'level-2': '2', 'level-3': '2' })
  })

  it('never loops on subagents that made each other: they have no todo to follow', () => {
    const children = all({
      todos: [todo('1')],
      subagents: [
        subagent('agent-a', { madeBy: 'agent-b' }),
        subagent('agent-b', { madeBy: 'agent-a' }),
        subagent('agent-c', { madeBy: 'agent-c' }),
      ],
      commits: [commit('abc123', { subagentToolUseId: 'agent-a' })],
    })

    expect(subagentTodos(children)).toEqual(new Map())
    expect(subagentTodo(children, 'agent-c')).toBeNull()
    expect(places(children)).toEqual({ 'commit abc123 /code/acme-api': UNFILED_TODO_ID })
  })

  it('needs only the todos, the subagents and the filings', () => {
    const plumbing = {
      todos: [todo('1')],
      subagents: [subagent('agent-a')],
      filings: [filing(SUBAGENT('agent-a'), '1')],
    }

    expect(subagentTodo(plumbing, 'agent-a')).toBe('1')
    expect(subagentTodos(plumbing).get('agent-a')).toBe('1')
  })
})

describe('groupChildren', () => {
  it('gives every todo that has an id a group, in the agent’s order, and one for the children under no todo', () => {
    const grouped = group({ todos: [todo('2'), todo('1'), todo('7')] })

    expect(grouped.todos.map(({ todoId }) => todoId)).toEqual(['2', '1', '7'])
    expect(grouped.unfiled.todoId).toBe(UNFILED_TODO_ID)
    for (const each of [...grouped.todos, grouped.unfiled]) {
      expect(each.children).toEqual([])
      expect(each.tallies).toEqual({ [ChildKind.File]: 0, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 })
    }
  })

  it('puts each file, link and commit under the todo its filing names, saying how it was filed', () => {
    const grouped = group({
      todos: [todo('1'), todo('2')],
      artifacts: [file('docs/plan.md'), link('https://example.com/pr/511')],
      commits: [commit('abc123')],
      filings: [
        filing(FILE('docs/plan.md'), '1'),
        filing(LINK('https://example.com/pr/511'), '2', FilingSource.Moved),
        filing(COMMIT('abc123'), '2'),
      ],
    })

    const [first, second] = grouped.todos
    expect(first?.children).toEqual([{ ...FILE('docs/plan.md'), updatedAt: 1_000, source: FilingSource.Named }])
    expect(second?.children.map(({ kind, key, source }) => [kind, key, source])).toEqual([
      [ChildKind.Link, 'https://example.com/pr/511', FilingSource.Moved],
      [ChildKind.Commit, 'abc123 /code/acme-api', FilingSource.Named],
    ])
    expect(grouped.unfiled.children).toEqual([])
  })

  describe('a subagent', () => {
    it('is never one of a todo’s children, filed or not, running or not', () => {
      const grouped = group({
        todos: [todo('1'), todo('2')],
        artifacts: [file('docs/plan.md')],
        subagents: [
          subagent('agent-a', { state: ToolCallState.Running }),
          subagent('agent-b', { madeBy: 'agent-a' }),
          subagent('agent-loose', { state: ToolCallState.Running }),
        ],
        filings: [filing(FILE('docs/plan.md'), '1'), filing(SUBAGENT('agent-a'), '1')],
      })

      expect(grouped.todos.map(refs)).toEqual([['file docs/plan.md'], []])
      expect(grouped.unfiled.children).toEqual([])
      expect(grouped.todos[0]?.tallies).toEqual({ [ChildKind.File]: 1, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 })
    })

    it('leaves a task that made nothing else with nothing under any todo, and nothing under none', () => {
      const grouped = group({
        todos: [todo('1')],
        subagents: [subagent('agent-a'), subagent('agent-b')],
        filings: [filing(SUBAGENT('agent-a'), '1')],
      })

      expect(grouped.todos.map(refs)).toEqual([[]])
      expect(grouped.unfiled.children).toEqual([])
    })

    it('has its commits under the todo it works on, and its own subagents’ commits too', () => {
      const grouped = group({
        todos: [todo('1'), todo('2')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        commits: [
          commit('abc123', { subagentToolUseId: 'agent-a', committedAt: 3_000 }),
          commit('def456', { subagentToolUseId: 'agent-b', committedAt: 2_000 }),
          commit('fed987'),
        ],
        filings: [filing(SUBAGENT('agent-a'), '2')],
      })

      expect(grouped.todos[1]?.children.map(({ kind, key, source }) => [kind, key, source])).toEqual([
        [ChildKind.Commit, 'abc123 /code/acme-api', FilingSource.Inherited],
        [ChildKind.Commit, 'def456 /code/acme-api', FilingSource.Inherited],
      ])
      expect(grouped.todos[1]?.tallies[ChildKind.Commit]).toBe(2)
      // The agent's own commit, which named no todo, stays where it was.
      expect(refs(grouped.unfiled)).toEqual(['commit fed987 /code/acme-api'])
    })

    it('has its commits follow it from three levels deep', () => {
      expect(
        places({
          todos: [todo('1'), todo('2')],
          subagents: [
            subagent('level-1'),
            subagent('level-2', { madeBy: 'level-1' }),
            subagent('level-3', { madeBy: 'level-2' }),
          ],
          commits: [
            commit('abc123', { subagentToolUseId: 'level-3' }),
            commit('def456', { subagentToolUseId: 'level-2' }),
          ],
          filings: [filing(SUBAGENT('level-1'), '2')],
        }),
      ).toEqual({ 'commit abc123 /code/acme-api': '2', 'commit def456 /code/acme-api': '2' })
    })

    it('brings its commits when it’s given another todo, apart from anything filed on its own', () => {
      const children = {
        todos: [todo('1'), todo('2'), todo('3')],
        artifacts: [file('docs/review.md')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        commits: [
          commit('abc123', { subagentToolUseId: 'agent-a' }),
          commit('def456', { subagentToolUseId: 'agent-b' }),
          commit('fed987', { subagentToolUseId: 'agent-a' }),
          commit('bad111', { subagentToolUseId: 'agent-a' }),
        ],
      }
      const own = [
        filing(COMMIT('fed987'), '3'),
        // Recorded as inherited when it was made: it still follows its subagent.
        filing(COMMIT('bad111'), '1', FilingSource.Inherited),
        // An artifact has no subagent to follow, so its inherited filing is what places it.
        filing(FILE('docs/review.md'), '1', FilingSource.Inherited),
      ]

      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '1'), ...own] })).toEqual({
        'commit abc123 /code/acme-api': '1',
        'commit def456 /code/acme-api': '1',
        'commit bad111 /code/acme-api': '1',
        'commit fed987 /code/acme-api': '3',
        'file docs/review.md': '1',
      })
      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '2', FilingSource.Moved), ...own] })).toEqual({
        'commit abc123 /code/acme-api': '2',
        'commit def456 /code/acme-api': '2',
        'commit bad111 /code/acme-api': '2',
        'commit fed987 /code/acme-api': '3',
        'file docs/review.md': '1',
      })
    })

    it.each([FilingSource.Named, FilingSource.Asked, FilingSource.Moved])(
      'leaves a commit of its own that was %s where it was filed',
      (source) => {
        const grouped = group({
          todos: [todo('1'), todo('2')],
          subagents: [subagent('agent-a')],
          commits: [commit('abc123', { subagentToolUseId: 'agent-a' })],
          filings: [filing(SUBAGENT('agent-a'), '1'), filing(COMMIT('abc123'), '2', source)],
        })

        expect(grouped.todos.map(refs)).toEqual([[], ['commit abc123 /code/acme-api']])
        expect(grouped.todos[1]?.children[0]?.source).toBe(source)
      },
    )

    it('with no todo, or one that’s gone, leaves its commits under none', () => {
      const children = {
        todos: [todo('1')],
        subagents: [subagent('agent-a'), subagent('agent-b', { madeBy: 'agent-a' })],
        commits: [commit('abc123', { subagentToolUseId: 'agent-b' })],
      }
      const unfiled = { 'commit abc123 /code/acme-api': UNFILED_TODO_ID }

      expect(places(children)).toEqual(unfiled)
      expect(places({ ...children, filings: [filing(SUBAGENT('agent-a'), '9')] })).toEqual(unfiled)
      expect(group(children).unfiled.children.every(({ source }) => source === null)).toBe(true)
      // A commit's own filing still holds, though: one filed under a todo that's there stays there.
      expect(places({ ...children, filings: [filing(COMMIT('abc123'), '1')] })).toEqual({
        'commit abc123 /code/acme-api': '1',
      })
    })

    it('doesn’t keep a commit whose own filing names a todo that’s gone', () => {
      expect(
        places({
          todos: [todo('1')],
          subagents: [subagent('agent-a')],
          commits: [commit('abc123', { subagentToolUseId: 'agent-a' })],
          filings: [filing(SUBAGENT('agent-a'), '1'), filing(COMMIT('abc123'), '9', FilingSource.Moved)],
        }),
      ).toEqual({ 'commit abc123 /code/acme-api': UNFILED_TODO_ID })
    })

    it('that isn’t known leaves its commit to its inherited filing', () => {
      const children = {
        todos: [todo('1')],
        commits: [
          commit('abc123', { subagentToolUseId: 'agent-gone' }),
          commit('def456', { subagentToolUseId: 'agent-gone' }),
        ],
      }

      expect(places(children)).toEqual({
        'commit abc123 /code/acme-api': UNFILED_TODO_ID,
        'commit def456 /code/acme-api': UNFILED_TODO_ID,
      })
      const filings = [
        filing(COMMIT('abc123'), '1', FilingSource.Inherited),
        filing(COMMIT('def456'), '9', FilingSource.Inherited),
      ]
      expect(places({ ...children, filings })).toEqual({
        'commit abc123 /code/acme-api': '1',
        'commit def456 /code/acme-api': UNFILED_TODO_ID,
      })
      expect(group({ ...children, filings }).todos[0]?.children[0]?.source).toBe(FilingSource.Inherited)
    })
  })

  it('puts a child with no filing in the placeholder group, with no source', () => {
    const grouped = group({
      todos: [todo('1')],
      artifacts: [file('docs/plan.md'), link('https://example.com/pr/511')],
      subagents: [subagent('agent-a')],
      commits: [commit('abc123')],
    })

    expect(grouped.todos[0]?.children).toEqual([])
    expect(refs(grouped.unfiled).sort()).toEqual([
      'commit abc123 /code/acme-api',
      'file docs/plan.md',
      'link https://example.com/pr/511',
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
      commits: [commit('abc123', { subagentToolUseId: 'agent-a' })],
      filings: [filing(FILE('docs/plan.md'), '2'), filing(SUBAGENT('agent-a'), '2')],
    }

    // Todo 2 is gone from the list: what was under it, and what its subagent committed, has no todo.
    const after = group({ ...children, todos: [todo('1'), todo('3')] })
    expect(after.todos.map(({ children: under }) => under)).toEqual([[], []])
    expect(refs(after.unfiled).sort()).toEqual(['commit abc123 /code/acme-api', 'file docs/plan.md'])
    expect(after.unfiled.children.every(({ source }) => source === null)).toBe(true)

    // The filings are still there, so a list that has the todo again has its children again.
    expect(places({ ...children, todos: [todo('2')] })).toEqual({
      'file docs/plan.md': '2',
      'commit abc123 /code/acme-api': '2',
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
      expect(grouped.todos[1]?.tallies[ChildKind.File]).toBe(1)
      expect(grouped.unfiled.children).toEqual([])
    }
    // Filed twice at the same moment: the one given last counts.
    const tied = filing(FILE('docs/plan.md'), '1', FilingSource.Moved, 6_000)
    expect(group({ todos, artifacts, filings: [second, tied] }).todos.map(refs)).toEqual([['file docs/plan.md'], []])
  })

  it('tells a file from a link with the same key, and a commit from the subagent a filing with its key names', () => {
    expect(
      places({
        todos: [todo('1'), todo('2')],
        artifacts: [file('same'), link('same')],
        subagents: [subagent('abc123 /code/acme-api')],
        commits: [commit('abc123')],
        filings: [filing(FILE('same'), '1'), filing(SUBAGENT('abc123 /code/acme-api'), '2')],
      }),
    ).toEqual({
      'file same': '1',
      'link same': UNFILED_TODO_ID,
      'commit abc123 /code/acme-api': UNFILED_TODO_ID,
    })
  })

  describe('a group’s counts', () => {
    it('count each kind it shows, and nothing else', () => {
      const grouped = group({
        todos: [todo('1')],
        artifacts: [file('a.md'), file('b.md'), link('https://example.com/pr/511')],
        subagents: [subagent('agent-a', { state: ToolCallState.Running }), subagent('agent-b')],
        commits: [commit('abc123'), commit('def456', { subagentToolUseId: 'agent-a' })],
        filings: [
          filing(FILE('a.md'), '1'),
          filing(FILE('b.md'), '1'),
          filing(LINK('https://example.com/pr/511'), '1'),
          filing(SUBAGENT('agent-a'), '1'),
          filing(SUBAGENT('agent-b'), '1'),
          filing(COMMIT('abc123'), '1'),
        ],
      })

      expect(grouped.todos[0]?.tallies).toEqual({ [ChildKind.File]: 2, [ChildKind.Link]: 1, [ChildKind.Commit]: 2 })
      expect(grouped.todos[0]?.children).toHaveLength(5)
    })

    it('count the placeholder’s children the same way', () => {
      const { unfiled } = group({ artifacts: [file('a.md')], subagents: [subagent('agent-a')] })

      expect(unfiled.tallies).toEqual({ [ChildKind.File]: 1, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 })
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
        commits: [commit('abc123', { committedAt: 1_000 }), commit('def456', { committedAt: 6_000 })],
      })

      expect(unfiled.children.map(({ key, updatedAt }) => [key, updatedAt])).toEqual([
        ['changed.md', 7_000],
        ['def456 /code/acme-api', 6_000],
        ['https://example.com/pr/511', 5_000],
        ['unseen.md', 3_000],
        ['abc123 /code/acme-api', 1_000],
      ])
    })

    it('keeps children updated at the same moment in the order they came: files and links, then commits', () => {
      const { unfiled } = group({
        artifacts: [link('https://example.com/pr/511'), file('a.md'), file('b.md')],
        commits: [commit('abc123'), commit('def456')],
      })

      expect(refs(unfiled)).toEqual([
        'link https://example.com/pr/511',
        'file a.md',
        'file b.md',
        'commit abc123 /code/acme-api',
        'commit def456 /code/acme-api',
      ])
    })
  })

  it('leaves what it was given alone', () => {
    const children: TaskChildren = {
      todos: [todo('1')],
      artifacts: [file('a.md', 1_000), file('b.md', 2_000)],
      subagents: [subagent('agent-a')],
      commits: [commit('abc123', { subagentToolUseId: 'agent-a' })],
      filings: [filing(FILE('a.md'), '1'), filing(FILE('b.md'), '1'), filing(SUBAGENT('agent-a'), '1')],
    }
    const before = structuredClone(children)

    groupChildren(children)
    subagentTodos(children)
    subagentTodo(children, 'agent-a')

    expect(children).toEqual(before)
  })

  it('groups 100 todos with 50 children under one, and hundreds more spread over the rest, each child once', () => {
    const todos = Array.from({ length: 100 }, (_, index) => todo(String(index + 1)))
    const artifacts = Array.from({ length: 300 }, (_, index) => file(`docs/file-${String(index)}.md`, index))
    const subagents = Array.from({ length: 60 }, (_, index) =>
      subagent(`agent-${String(index)}`, {
        ...(index % 3 === 0 ? {} : { madeBy: `agent-${String(index - 1)}` }),
        state: index === 30 ? ToolCallState.Running : ToolCallState.Done,
      }),
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
      // Each top-level subagent works on a todo of its own, and so do its two nested ones: their commits follow.
      ...subagents
        .filter((call) => call.parentToolUseId === null)
        .map((call, index) => filing(SUBAGENT(call.toolUseId), String(index + 2))),
    ]

    const grouped = group({ todos, artifacts, subagents, commits, filings })

    const everything = [...grouped.todos, grouped.unfiled].flatMap(refs)
    // Every file and commit once, and no subagent anywhere.
    expect(everything).toHaveLength(300 + 80)
    expect(new Set(everything).size).toBe(everything.length)
    expect(everything.filter((ref) => ref.startsWith('subagent'))).toEqual([])
    expect(grouped.todos).toHaveLength(100)
    expect(grouped.todos[0]?.tallies[ChildKind.File]).toBe(50)
    expect(grouped.todos[0]?.children.map(({ updatedAt }) => updatedAt)).toEqual(
      Array.from({ length: 50 }, (_, index) => 49 - index),
    )
    // The eleventh top-level subagent (index 30) works on todo 12, and its two nested ones with it: three commits.
    expect(grouped.todos[11]?.tallies[ChildKind.Commit]).toBe(3)
    expect(subagentTodos(all({ todos, subagents, filings })).size).toBe(60)
    expect(subagentTodo(all({ todos, subagents, filings }), 'agent-32')).toBe('12')
    // Only the main agent's own commits have no todo.
    expect(refs(grouped.unfiled)).toHaveLength(20)
    for (const { children } of grouped.todos) {
      const times = children.map(({ updatedAt }) => updatedAt)
      expect(times).toEqual([...times].sort((a, b) => b - a))
    }
  })
})

describe('a child as one string', () => {
  it('is its kind and its key, so a file and a link never share one', () => {
    expect(refKey(FILE('docs/plan.md'))).toBe('file:docs/plan.md')
    expect(refKey(LINK('docs/plan.md'))).toBe('link:docs/plan.md')
    expect(refKey(SUBAGENT('abc123'))).not.toBe(refKey({ kind: ChildKind.Commit, key: 'abc123' }))
  })
})

describe('subagentsOf', () => {
  function call(toolUseId: string, fields: Partial<ToolCallEvent> = {}): ToolCallEvent {
    return { ...subagent(toolUseId), state: ToolCallState.Running, ...fields }
  }

  function note(id: string, parentToolUseId: string | null, createdAt: number): ToolEvent {
    return { id, taskId: TASK, turn: 1, createdAt, kind: ToolEventKind.Narration, text: 'Checking.', parentToolUseId }
  }

  it('is every Agent call in the order they started, a subagent’s own included, and no other entry', () => {
    const events: ToolEvent[] = [
      call('read', { name: 'Read' }),
      call('agent-a'),
      call('agent-b', { name: 'Task', parentToolUseId: 'agent-a' }),
      note('n1', null, 1_500),
      note('n2', 'agent-a', 1_600),
      call('bash', { name: 'Bash', parentToolUseId: 'agent-b' }),
      {
        id: 'd1',
        taskId: TASK,
        turn: 1,
        createdAt: 12_000,
        kind: ToolEventKind.Divider,
        dividerKind: DividerKind.Turn,
      },
    ]

    expect(subagentsOf(events)).toEqual([events[1], events[2]])
    expect(subagentsOf([])).toEqual([])
  })

  it('resolves the same as main does from the stored log: a subagent’s commit under the todo it works on', () => {
    const events: ToolEvent[] = [call('agent-a', { createdAt: 1_000 }), note('said', 'agent-a', 4_000)]
    const children = all({
      todos: [todo('1')],
      subagents: subagentsOf(events),
      commits: [commit('abc123', { subagentToolUseId: 'agent-a', committedAt: 4_500 })],
      filings: [filing(SUBAGENT('agent-a'), '1')],
    })

    expect(groupChildren(children).todos[0]?.children).toEqual([
      { ...COMMIT('abc123'), updatedAt: 4_500, source: FilingSource.Inherited },
    ])
    expect(subagentTodo(children, 'agent-a')).toBe('1')
  })
})

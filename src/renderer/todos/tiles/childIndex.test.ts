import { describe, expect, it } from 'vitest'
import { ArtifactKind, ToolCallState, ToolEventKind, type Artifact, type ToolCallEvent } from '../../../shared/domain'
import { ChildKind, childRefKey, commitChildKey } from '../../../shared/todoHub'
import { sampleCommit, sampleWatcher } from '../../store/test-bridge'
import { findArtifact, findCommit, findSubagent, findWatcher, subagentsIn } from './childIndex'

function file(path: string): Artifact {
  return {
    kind: ArtifactKind.File,
    taskId: 't1',
    path,
    title: path,
    addedAt: 1,
    updatedAt: 1,
    modifiedAt: null,
    missing: false,
  }
}

function link(url: string): Artifact {
  return { kind: ArtifactKind.Link, taskId: 't1', url, title: url, addedAt: 1, updatedAt: 1 }
}

function call(toolUseId: string, fields: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: `event-${toolUseId}`,
    taskId: 't1',
    turn: 1,
    createdAt: 1_000,
    kind: ToolEventKind.ToolCall,
    name: 'Agent',
    input: { description: toolUseId },
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId,
    parentToolUseId: null,
    progressSummary: null,
    ...fields,
  }
}

const fileRef = (path: string): string => childRefKey({ kind: ChildKind.File, key: path })
const linkRef = (url: string): string => childRefKey({ kind: ChildKind.Link, key: url })

describe('finding a child among the store’s lists', () => {
  it('finds an artifact by its kind and its path or URL, and nothing for one the task hasn’t got', () => {
    const artifacts = [file('docs/limits.md'), link('https://github.com/acme/api/pull/511')]
    expect(findArtifact(artifacts, fileRef('docs/limits.md'))).toBe(artifacts[0])
    expect(findArtifact(artifacts, linkRef('https://github.com/acme/api/pull/511'))).toBe(artifacts[1])
    expect(findArtifact(artifacts, fileRef('docs/other.md'))).toBeUndefined()
    // A file is never found as a link, whatever its path.
    expect(findArtifact(artifacts, linkRef('docs/limits.md'))).toBeUndefined()
  })

  it('finds nothing in a list the store hasn’t loaded', () => {
    expect(findArtifact(undefined, fileRef('docs/limits.md'))).toBeUndefined()
    expect(findSubagent(undefined, 'agent-a')).toBeUndefined()
    expect(findWatcher(undefined, 'watch-a')).toBeUndefined()
    expect(findCommit(undefined, 'abc /code/api')).toBeUndefined()
  })

  it('finds a watcher by the call that started it, and a commit by its hash and working tree', () => {
    const watchers = [
      sampleWatcher('w1', 't1', { toolUseId: 'watch-a' }),
      sampleWatcher('w2', 't1', { toolUseId: 'watch-b' }),
    ]
    expect(findWatcher(watchers, 'watch-b')).toBe(watchers[1])
    const commits = [sampleCommit('c1', 't1', { hash: 'abc' }), sampleCommit('c2', 't1', { hash: 'def' })]
    const [, second] = commits
    if (second === undefined) throw new Error('No commit')
    expect(findCommit(commits, commitChildKey(second))).toBe(second)
    expect(findCommit(commits, 'abc /elsewhere')).toBeUndefined()
  })

  it('finds a subagent by its Agent call, with when it last did anything', () => {
    const events = [
      call('agent-a'),
      call('did-1', { name: 'Bash', parentToolUseId: 'agent-a', createdAt: 2_000, finishedAt: 2_500 }),
      call('agent-b', { state: ToolCallState.Done, finishedAt: 4_000 }),
    ]
    expect(findSubagent(events, 'agent-a')).toEqual({ call: events[0], lastActivityAt: 2_500 })
    expect(findSubagent(events, 'agent-b')).toEqual({ call: events[2], lastActivityAt: 4_000 })
    // A subagent's own call isn't a subagent.
    expect(findSubagent(events, 'did-1')).toBeUndefined()
  })

  it('keeps the first of two with one key, which the store never has', () => {
    const watchers = [
      sampleWatcher('w1', 't1', { toolUseId: 'watch-a' }),
      sampleWatcher('w2', 't1', { toolUseId: 'watch-a' }),
    ]
    expect(findWatcher(watchers, 'watch-a')).toBe(watchers[0])
  })
})

describe('indexing once per list', () => {
  it('works a log’s subagents out once, and again only for a new log', () => {
    const events = [call('agent-a')]
    const first = subagentsIn(events)
    expect(subagentsIn(events)).toBe(first)
    // The same subagent object each time a tile asks, so a tile whose subagent hasn't changed doesn't render.
    expect(findSubagent(events, 'agent-a')).toBe(first[0])
    expect(findSubagent(events, 'agent-a')).toBe(findSubagent(events, 'agent-a'))
    expect(subagentsIn([...events])).not.toBe(first)
  })

  it('reads a list of 5,000 entries once for any number of lookups', () => {
    let reads = 0
    const watchers = Array.from({ length: 5_000 }, (_, index) =>
      sampleWatcher(`w${String(index)}`, 't1', { toolUseId: `use-${String(index)}` }),
    )
    const counted = new Proxy(watchers, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) reads += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    for (let index = 0; index < 200; index += 1) {
      expect(findWatcher(counted, `use-${String(index * 20)}`)?.id).toBe(`w${String(index * 20)}`)
    }
    expect(reads).toBe(1)
  })
})

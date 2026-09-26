// Compaction as the SDK says it (#279): where it compacts automatically (`getContextUsage`, asked after each turn), and
// what each compaction carried over (the `PostCompact` hook). A fake agent session behind the real bridge, saving to a
// database, in the shapes the SDK was probed to answer and call with (`docs/sdk-notes.md` §5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  AutoCompactKind,
  CompactionTrigger,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type Task,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import type { AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]
let log: MemoryLog

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    log: log.logger,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  log = createMemoryLog()
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** The auto-compact settings main told the window about, in order. */
function autoCompactUpdates(): unknown[] {
  return events.flatMap((event) => (event.type === EventType.TaskUpdated ? [event.task.autoCompact] : []))
}

/** What the SDK's `getContextUsage` answered in the probe, with auto-compact as given. */
function usage(compacts: Record<string, unknown>): unknown {
  return { totalTokens: 21_811, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 11, ...compacts }
}

const AT_167K = { autoCompactThreshold: 167_000, isAutoCompactEnabled: true }
const ON_167K = { kind: AutoCompactKind.On, thresholdTokens: 167_000 }

/** A promise, and what settles it. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((settleIt) => {
    resolve = settleIt
  })
  return { promise, resolve }
}

/** Sends a message and plays its turn to the end. */
async function turn(text = 'Move the uploads to S3.'): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  backend.session.emit(sdk.init(), sdk.text('Done.'), sdk.result('Done.'))
  await settle()
}

describe('where the SDK compacts automatically', () => {
  it('is asked after each turn and kept on the task, and sent to the window only when it changes', async () => {
    backend.onSessionStart = (session) => {
      session.onContextUsage = () => Promise.resolve(usage(AT_167K))
    }
    await turn()

    expect(backend.session.contextUsageAsked).toBe(1)
    expect(current().autoCompact).toEqual(ON_167K)
    expect(autoCompactUpdates().at(-1)).toEqual(ON_167K)

    events.splice(0)
    await turn('Now the stored paths.')
    expect(backend.session.contextUsageAsked).toBe(2)
    expect(autoCompactUpdates().filter((value) => value !== null)).toEqual([ON_167K, ON_167K])
    expect(log.withMessage('auto-compact changed')).toHaveLength(1)
  })

  it('follows the user’s settings: a smaller window’s threshold, then auto-compact switched off', async () => {
    let answer = usage({ autoCompactThreshold: 67_000, isAutoCompactEnabled: true, autocompactSource: 'settings' })
    backend.onSessionStart = (session) => {
      session.onContextUsage = () => Promise.resolve(answer)
    }
    await turn()
    expect(current().autoCompact).toEqual({ kind: AutoCompactKind.On, thresholdTokens: 67_000 })

    answer = usage({ isAutoCompactEnabled: false })
    await turn('Again.')
    expect(current().autoCompact).toEqual({ kind: AutoCompactKind.Off })
  })

  it('keeps the last known value when asking fails, or the answer says nothing of it', async () => {
    let answer: () => Promise<unknown> = () => Promise.resolve(usage(AT_167K))
    backend.onSessionStart = (session) => {
      session.onContextUsage = () => answer()
    }
    await turn()

    answer = () => Promise.reject(new Error('Query closed before response received'))
    await turn('Again.')
    expect(current().autoCompact).toEqual(ON_167K)
    expect(log.withMessage('could not read the context usage; keeping the last known')).toMatchObject([
      { fields: { error: 'Query closed before response received' } },
    ])

    answer = () => Promise.resolve(usage({ isAutoCompactEnabled: true }))
    await turn('And again.')
    answer = () => Promise.resolve('nonsense')
    await turn('Once more.')
    expect(current().autoCompact).toEqual(ON_167K)
    expect(log.withMessage('the context usage says nothing of auto-compact; keeping the last known')).toHaveLength(2)
  })

  it('stays unknown when the SDK never says, so the meter falls back to its default', async () => {
    backend.onSessionStart = (session) => {
      session.onContextUsage = () => Promise.reject(new Error('Query closed before response received'))
    }
    await turn()
    expect(current().autoCompact).toBeNull()
  })

  it('is dropped when the model changes before the SDK answers, or the session has closed', async () => {
    const answers: ReturnType<typeof deferred>[] = []
    backend.onSessionStart = (session) => {
      session.onContextUsage = () => {
        const answer = deferred()
        answers.push(answer)
        return answer.promise
      }
    }
    await turn()
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { model: 'claude-sample-2[1m]' } })
    answers[0]?.resolve(usage(AT_167K))
    await settle()
    expect(current().autoCompact).toBeNull()

    await turn('Again.')
    runner.close()
    answers[1]?.resolve(usage(AT_167K))
    await settle()
    expect(current().autoCompact).toBeNull()
  })
})

describe('what a compaction carried over', () => {
  const WRITTEN = [
    '<analysis>',
    'The user asked to move the uploads to S3.',
    '</analysis>',
    '',
    '<summary>',
    '1. Primary Request and Intent:',
    '   Move user image uploads from local disk to S3.',
    '</summary>',
  ].join('\n')
  const CARRIED = '1. Primary Request and Intent:\n   Move user image uploads from local disk to S3.'

  function compactions(): CompactionEvent[] {
    return listToolEvents(database.db, task.id).filter(
      (event): event is CompactionEvent => event.kind === ToolEventKind.Compaction,
    )
  }

  /** What the SDK streams for a compaction, split where its `PostCompact` hook runs. */
  function compactingThen(summary: string | null, trigger: 'manual' | 'auto' = 'manual'): void {
    const [status, outcome, boundary, continued] = sdk.compaction(198_000, 41_000, trigger)
    backend.session.emit(status)
    if (summary !== null) {
      backend.session.compacted({
        trigger: trigger === 'auto' ? CompactionTrigger.Auto : CompactionTrigger.Manual,
        summary,
      })
    }
    backend.session.emit(outcome, boundary, continued)
  }

  it('is kept on a manual compaction’s row, without the analysis, and after a relaunch', async () => {
    await turn()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    compactingThen(WRITTEN)
    backend.session.emit(sdk.compactResult())
    await settle()

    expect(compactions()).toMatchObject([
      { trigger: CompactionTrigger.Manual, state: ToolCallState.Done, postTokens: 41_000, summary: CARRIED },
    ])
    expect(
      events.some(
        (event) =>
          event.type === EventType.ToolEventUpdated &&
          event.toolEvent.kind === ToolEventKind.Compaction &&
          event.toolEvent.summary === CARRIED,
      ),
    ).toBe(true)
    expect(log.withMessage('compaction summary')).toMatchObject([
      { fields: { trigger: CompactionTrigger.Manual, length: WRITTEN.length } },
    ])

    runner.close()
    launch()
    const { toolEvents } = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(toolEvents.find((event) => event.kind === ToolEventKind.Compaction)).toMatchObject({ summary: CARRIED })
  })

  it('is kept on an automatic compaction’s row, mid-turn, whether or not the SDK said it was compacting', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Move the uploads to S3.' })
    backend.session.emit(sdk.init(), sdk.withContextUsed(sdk.text('Copying.'), 168_000))
    compactingThen(WRITTEN, 'auto')
    await settle()
    backend.session.compacted({ trigger: CompactionTrigger.Auto, summary: '<summary>Second.</summary>' })
    backend.session.emit(sdk.compactBoundary({ trigger: 'auto', pre_tokens: 170_000, post_tokens: 30_000 }))
    backend.session.emit(sdk.text('Carrying on.'), sdk.result('Carrying on.'))
    await settle()

    expect(compactions()).toMatchObject([
      { trigger: CompactionTrigger.Auto, state: ToolCallState.Done, summary: CARRIED },
      { trigger: CompactionTrigger.Auto, state: ToolCallState.Done, summary: 'Second.' },
    ])
  })

  it('is none for an empty summary, or when the hook never said', async () => {
    await turn()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    compactingThen('<analysis>Nothing to carry.</analysis>')
    backend.session.emit(sdk.compactResult())
    await settle()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    compactingThen(null)
    backend.session.emit(sdk.compactResult())
    await settle()

    expect(compactions().map(({ state, summary }) => [state, summary])).toEqual([
      [ToolCallState.Done, null],
      [ToolCallState.Done, null],
    ])
  })

  it('isn’t carried to the next compaction from one that failed, or one that never reported', async () => {
    await turn()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    backend.session.emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sdk.SESSION_ID })
    backend.session.compacted({ trigger: CompactionTrigger.Manual, summary: 'Lost.' })
    backend.session.emit(
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed', session_id: sdk.SESSION_ID },
      sdk.compactResult(),
    )
    await settle()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    backend.session.compacted({ trigger: CompactionTrigger.Manual, summary: 'Also lost.' })
    backend.session.emit(sdk.compactResult())
    await settle()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    compactingThen(null)
    backend.session.emit(sdk.compactResult())
    await settle()

    expect(compactions().map(({ state, summary }) => [state, summary])).toEqual([
      [ToolCallState.Error, null],
      [ToolCallState.Error, null],
      [ToolCallState.Done, null],
    ])
  })

  it('is ignored once the session has closed', async () => {
    await turn()
    const { session } = backend
    runner.close()
    session.compacted({ trigger: CompactionTrigger.Manual, summary: 'Too late.' })
    expect(log.withMessage('compaction summary')).toEqual([])
  })
})

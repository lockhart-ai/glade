// What a plugin can see, and so open (#466): the tasks and subagents its feed told it of, kept from what it's sent.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PluginEventType,
  PluginPermissionOutcome,
  PluginQuestionOutcome,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  PluginToolCallState,
  type PluginEvent,
  type PluginSubagent,
  type PluginTask,
} from '../../shared/plugin-api'
import { createPluginSight, SightRefusal, type PluginSight } from './sight'

function task(id: string, state = PluginTaskState.Active): PluginTask {
  return {
    id,
    workspaceId: 'w1',
    workspaceName: 'Acme API',
    title: 'Fix the date bug',
    status: '',
    state,
    activity: PluginTaskActivity.Working,
    needsYou: false,
    waitingOn: null,
    watchers: 0,
    createdAt: 1,
    updatedAt: 1,
    doneAt: state === PluginTaskState.Done ? 2 : null,
  }
}

function subagent(id: string, taskId: string, state = PluginSubagentState.Running): PluginSubagent {
  return { id, taskId, name: 'Check links', state, latest: null, startedAt: 1, endedAt: null }
}

function snapshot(tasks: readonly PluginTask[], subagents: readonly PluginSubagent[] = []): PluginEvent {
  return { type: PluginEventType.Snapshot, tasks, subagents, questions: [], permissions: [] }
}

let sight: PluginSight

beforeEach(() => {
  sight = createPluginSight()
})

describe('createPluginSight', () => {
  it('sees nothing before a snapshot', () => {
    expect(sight.refusal('t1', null)).toBe(SightRefusal.UnknownTask)
  })

  it("sees the snapshot's tasks and their subagents", () => {
    sight.see(snapshot([task('t1'), task('t2')], [subagent('kitten', 't1')]))

    expect(sight.refusal('t1', null)).toBeNull()
    expect(sight.refusal('t2', null)).toBeNull()
    expect(sight.refusal('t1', 'kitten')).toBeNull()
    expect(sight.refusal('t3', null)).toBe(SightRefusal.UnknownTask)
  })

  it("refuses a subagent it wasn't told of, or another task's", () => {
    sight.see(snapshot([task('t1'), task('t2')], [subagent('kitten', 't1')]))

    expect(sight.refusal('t2', 'kitten')).toBe(SightRefusal.UnknownSubagent)
    expect(sight.refusal('t1', 'stray')).toBe(SightRefusal.UnknownSubagent)
  })

  it('sees tasks created after the snapshot, and refuses one once it is done, until it is reopened', () => {
    sight.see(snapshot([]))
    sight.see({ type: PluginEventType.TaskCreated, task: task('t1') })
    expect(sight.refusal('t1', null)).toBeNull()

    sight.see({ type: PluginEventType.TaskUpdated, task: task('t1', PluginTaskState.Done) })
    expect(sight.refusal('t1', null)).toBe(SightRefusal.DoneTask)

    sight.see({ type: PluginEventType.TaskUpdated, task: task('t1') })
    expect(sight.refusal('t1', null)).toBeNull()
  })

  it('forgets a deleted task and its subagents', () => {
    sight.see(snapshot([task('t1'), task('t2')], [subagent('kitten', 't1'), subagent('other', 't2')]))
    sight.see({ type: PluginEventType.TaskDeleted, taskId: 't1' })

    expect(sight.refusal('t1', null)).toBe(SightRefusal.UnknownTask)
    expect(sight.refusal('t1', 'kitten')).toBe(SightRefusal.UnknownTask)
    expect(sight.refusal('t2', 'other')).toBeNull()

    // Its subagent comes back only if it's told of again, with a task it can see.
    sight.see({ type: PluginEventType.TaskCreated, task: task('t1') })
    expect(sight.refusal('t1', 'kitten')).toBe(SightRefusal.UnknownSubagent)
  })

  it('sees subagents started after the snapshot, and keeps one it was told ended', () => {
    sight.see(snapshot([task('t1')]))
    sight.see({ type: PluginEventType.SubagentStarted, subagent: subagent('kitten', 't1') })
    expect(sight.refusal('t1', 'kitten')).toBeNull()

    sight.see({ type: PluginEventType.SubagentUpdated, subagent: subagent('late', 't1', PluginSubagentState.Done) })
    sight.see({ type: PluginEventType.SubagentUpdated, subagent: subagent('kitten', 't1', PluginSubagentState.Done) })
    expect(sight.refusal('t1', 'kitten')).toBeNull()
    expect(sight.refusal('t1', 'late')).toBeNull()
  })

  it('starts over with each snapshot', () => {
    sight.see(snapshot([task('t1')], [subagent('kitten', 't1')]))
    sight.see({ type: PluginEventType.TaskCreated, task: task('t2') })
    sight.see(snapshot([task('t3')]))

    expect(sight.refusal('t1', null)).toBe(SightRefusal.UnknownTask)
    expect(sight.refusal('t2', null)).toBe(SightRefusal.UnknownTask)
    expect(sight.refusal('t3', 'kitten')).toBe(SightRefusal.UnknownSubagent)
    expect(sight.refusal('t3', null)).toBeNull()
  })

  it("learns nothing from events that only mention a task or subagent, and isn't fooled by them", () => {
    sight.see(snapshot([task('t1')]))
    const mentions: PluginEvent[] = [
      { type: PluginEventType.Hello, app: { name: 'Glade', version: '0.21.0' } },
      {
        type: PluginEventType.AgentToolCall,
        call: {
          id: 'c1',
          taskId: 't9',
          subagentId: 'ghost',
          tool: 'Bash',
          summary: 'npm test',
          state: PluginToolCallState.Running,
          startedAt: 1,
          endedAt: null,
        },
      },
      { type: PluginEventType.AgentNote, taskId: 't9', subagentId: 'ghost', text: 'Hm', at: 1 },
      {
        type: PluginEventType.QuestionOpened,
        question: { taskId: 't9', questionSetId: 'q', prompts: [], openedAt: 1 },
      },
      {
        type: PluginEventType.QuestionClosed,
        taskId: 't9',
        questionSetId: 'q',
        outcome: PluginQuestionOutcome.Answered,
      },
      {
        type: PluginEventType.PermissionOpened,
        request: { taskId: 't9', requestId: 'p', subagentId: 'ghost', tool: 'Bash', summary: '', openedAt: 1 },
      },
      {
        type: PluginEventType.PermissionClosed,
        taskId: 't9',
        requestId: 'p',
        outcome: PluginPermissionOutcome.Allowed,
      },
      {
        type: PluginEventType.MachineReading,
        reading: { t: 1, cpuCount: 8, total: 1, claude: 0, docker: 0, gpu: null, containers: [] },
      },
      { type: PluginEventType.SettingsChanged, settings: {} },
    ]
    for (const event of mentions) sight.see(event)

    expect(sight.refusal('t9', null)).toBe(SightRefusal.UnknownTask)
    expect(sight.refusal('t1', 'ghost')).toBe(SightRefusal.UnknownSubagent)
    expect(sight.refusal('t1', null)).toBeNull()
  })
})

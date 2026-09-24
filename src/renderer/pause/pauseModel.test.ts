import { describe, expect, it } from 'vitest'
import { PauseReason, TaskActivity, TaskState, type Task, type TaskPause } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  bannerText,
  isPaused,
  offersSwitchModel,
  pausedChatLine,
  pausedStatusLine,
  pausedTasks,
  pauseReasonLabel,
  resumeTime,
  switchableTasks,
  type PausedTask,
} from './pauseModel'

const NOW = new Date(2026, 8, 23, 11, 0).getTime()
const AT_11_42 = new Date(2026, 8, 23, 11, 42).getTime()
const AT_12_05 = new Date(2026, 8, 23, 12, 5).getTime()

function pause(reason: PauseReason, resumesAt = AT_11_42): TaskPause {
  return { reason, since: NOW, resumesAt, checks: 0, details: `${reason} details` }
}

function paused(
  id: string,
  reason: PauseReason,
  resumesAt = AT_11_42,
  patch: Partial<Omit<Task, 'pause'>> = {},
): PausedTask {
  return { ...sampleTask(id, 'w1'), activity: TaskActivity.Paused, pause: pause(reason, resumesAt), ...patch }
}

describe('isPaused and pausedTasks', () => {
  it('finds the active, paused tasks in every workspace, the one that resumes first first', () => {
    const later = paused('later', PauseReason.UsageLimit, AT_12_05)
    const sooner = paused('sooner', PauseReason.UsageLimit)
    const offline = { ...paused('offline', PauseReason.Offline), workspaceId: 'w2', createdAt: 1 }
    const tie = { ...paused('tie', PauseReason.Offline), createdAt: 5_000 }
    const done = paused('done', PauseReason.UsageLimit, AT_11_42, { state: TaskState.Done })
    const working = sampleTask('working', 'w1')
    const pauseless: Task = { ...sampleTask('odd', 'w1'), activity: TaskActivity.Paused }

    expect(isPaused(sooner)).toBe(true)
    expect(isPaused(done)).toBe(false)
    expect(isPaused(pauseless)).toBe(false)
    const tasks = Object.fromEntries([later, tie, sooner, offline, done, working, pauseless].map((t) => [t.id, t]))
    expect(pausedTasks(tasks).map((task) => task.id)).toEqual(['offline', 'sooner', 'tie', 'later'])
  })
})

describe('resumeTime', () => {
  it('gives the time of day today, and the day too on another day', () => {
    expect(resumeTime(AT_11_42, NOW)).toBe('11:42')
    expect(resumeTime(new Date(2026, 8, 27, 9, 5).getTime(), NOW)).toBe('Sep 27 09:05')
  })
})

describe('the paused lines', () => {
  it('say why the turn is paused and when it resumes, in the task list and the chat', () => {
    expect(pausedStatusLine(pause(PauseReason.UsageLimit), NOW)).toBe('Paused: usage limit · resumes 11:42')
    expect(pausedStatusLine(pause(PauseReason.Offline), NOW)).toBe('Paused: offline')
    expect(pausedChatLine(pause(PauseReason.UsageLimit), NOW)).toBe('Paused · resumes at 11:42')
    expect(pausedChatLine(pause(PauseReason.Offline), NOW)).toBe('Paused · resumes when the network is back')
    expect(pauseReasonLabel(PauseReason.UsageLimit)).toBe('Usage limit')
    expect(pauseReasonLabel(PauseReason.Offline)).toBe('Offline')
  })
})

describe('bannerText', () => {
  it('says nothing while no task is paused', () => {
    expect(bannerText([], NOW)).toBeNull()
  })

  it('counts the tasks a usage limit paused, and says when the last resumes', () => {
    const three = [
      paused('a', PauseReason.UsageLimit),
      paused('b', PauseReason.UsageLimit, AT_12_05),
      paused('c', PauseReason.UsageLimit),
    ]

    expect(bannerText(three, NOW)).toEqual({
      title: 'Usage limit reached.',
      text: '3 tasks are paused and will resume on their own at 12:05.',
    })
    expect(bannerText([paused('a', PauseReason.UsageLimit)], NOW)).toEqual({
      title: 'Usage limit reached.',
      text: '1 task is paused and will resume on its own at 11:42.',
    })
  })

  it('says offline tasks resume when the network is back', () => {
    expect(bannerText([paused('a', PauseReason.Offline), paused('b', PauseReason.Offline)], NOW)).toEqual({
      title: 'Can’t reach the API.',
      text: '2 tasks are paused and will resume on their own when the network is back.',
    })
  })

  it('names both reasons, but no time, for some of each', () => {
    expect(bannerText([paused('a', PauseReason.Offline), paused('b', PauseReason.UsageLimit)], NOW)).toEqual({
      title: 'Usage limit reached, and can’t reach the API.',
      text: '2 tasks are paused and will resume on their own.',
    })
  })
})

describe('Switch model', () => {
  it('is offered for, and moves, only the tasks a usage limit paused', () => {
    const limited = paused('a', PauseReason.UsageLimit)
    const offline = paused('b', PauseReason.Offline)

    expect(offersSwitchModel([limited, offline])).toBe(true)
    expect(offersSwitchModel([offline])).toBe(false)
    expect(switchableTasks([limited, offline])).toEqual([limited])
  })
})

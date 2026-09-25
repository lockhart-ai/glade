import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import { GIF, JPEG, PNG, WEBP } from '../../../shared/test-images'
import { ImageOwnerKind, imageRefsOf } from './images'
import { getInputDraft, setInputDraft } from './input-drafts'
import { deleteTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

function draftRows(): unknown {
  return test.db.prepare('SELECT COUNT(*) FROM input_drafts').pluck().get()
}

function draftImageRows(): unknown {
  return test.db.prepare('SELECT COUNT(*) FROM images WHERE draft_task_id IS NOT NULL').pluck().get()
}

describe('getInputDraft', () => {
  it('has none for a task that was never given one, or that isn’t there', () => {
    expect(getInputDraft(test.db, task.id)).toBeUndefined()
    expect(getInputDraft(test.db, 'missing')).toBeUndefined()
  })
})

describe('setInputDraft', () => {
  it('keeps a draft’s text and images, in order, and gives them back', () => {
    expect(setInputDraft(test.db, { taskId: task.id, text: 'Check the rate limits', images: [PNG, JPEG, GIF] })).toBe(
      true,
    )
    expect(getInputDraft(test.db, task.id)).toEqual({ text: 'Check the rate limits', images: [PNG, JPEG, GIF] })
  })

  it('keeps text exactly as typed, whitespace and all', () => {
    const text = '  Line one\n\n\tline two  \n'
    setInputDraft(test.db, { taskId: task.id, text })
    expect(getInputDraft(test.db, task.id)).toEqual({ text, images: [] })
  })

  it('replaces the text each time, keeping the images when none are given', () => {
    setInputDraft(test.db, { taskId: task.id, text: 'Ch', images: [PNG] })
    setInputDraft(test.db, { taskId: task.id, text: 'Check the' }, 3_000)
    setInputDraft(test.db, { taskId: task.id, text: 'Check the rate limits' }, 4_000)

    expect(getInputDraft(test.db, task.id)).toEqual({ text: 'Check the rate limits', images: [PNG] })
    expect(draftRows()).toBe(1)
    expect(test.db.prepare('SELECT updated_at FROM input_drafts').pluck().get()).toBe(4_000)
  })

  it('replaces the images when they’re given, keeping none of the old ones', () => {
    setInputDraft(test.db, { taskId: task.id, text: 'See these', images: [PNG, JPEG] })
    const [first] = imageRefsOf(test.db, { kind: ImageOwnerKind.Draft, id: task.id })

    setInputDraft(test.db, { taskId: task.id, text: 'See these', images: [WEBP] })

    expect(getInputDraft(test.db, task.id)).toEqual({ text: 'See these', images: [WEBP] })
    expect(draftImageRows()).toBe(1)
    expect(imageRefsOf(test.db, { kind: ImageOwnerKind.Draft, id: task.id })).not.toContainEqual(first)
  })

  it('keeps a draft of images only', () => {
    setInputDraft(test.db, { taskId: task.id, text: '', images: [GIF] })
    expect(getInputDraft(test.db, task.id)).toEqual({ text: '', images: [GIF] })
    // Its text going leaves the images.
    setInputDraft(test.db, { taskId: task.id, text: 'x' })
    setInputDraft(test.db, { taskId: task.id, text: '' })
    expect(getInputDraft(test.db, task.id)).toEqual({ text: '', images: [GIF] })
  })

  it('stores nothing for an empty draft, and removes the one there was, images and all', () => {
    setInputDraft(test.db, { taskId: task.id, text: '' })
    setInputDraft(test.db, { taskId: task.id, text: '', images: [] })
    expect(draftRows()).toBe(0)

    setInputDraft(test.db, { taskId: task.id, text: 'Half a thought', images: [PNG] })
    setInputDraft(test.db, { taskId: task.id, text: '', images: [] })
    expect(getInputDraft(test.db, task.id)).toBeUndefined()
    expect(draftRows()).toBe(0)
    expect(draftImageRows()).toBe(0)

    setInputDraft(test.db, { taskId: task.id, text: 'Text only' })
    setInputDraft(test.db, { taskId: task.id, text: '' })
    expect(draftRows()).toBe(0)
  })

  it('does nothing for a task that isn’t there, answering false', () => {
    expect(setInputDraft(test.db, { taskId: 'missing', text: 'Lost', images: [PNG] })).toBe(false)
    expect(draftRows()).toBe(0)
    expect(draftImageRows()).toBe(0)
  })

  it('keeps a large draft whole', () => {
    // 2 MB of text, more than anyone types, with every character kind a textarea gives.
    const text = 'Ünïcode ✓ 🙂 line\n\t'.repeat(100_000)
    setInputDraft(test.db, { taskId: task.id, text })
    expect(getInputDraft(test.db, task.id)?.text).toBe(text)
  })

  it('keeps each task’s draft apart, many at once, and deleting one task leaves the rest', () => {
    const workspaceId = task.workspaceId
    const tasks = Array.from({ length: 50 }, () => sampleTask(test.db, workspaceId))
    tasks.forEach(({ id }, index) => {
      setInputDraft(test.db, { taskId: id, text: `Draft ${String(index)}`, images: index % 2 === 0 ? [PNG] : [] })
    })

    const [doomed, ...kept] = tasks
    deleteTask(test.db, doomed?.id ?? '')

    expect(getInputDraft(test.db, doomed?.id ?? '')).toBeUndefined()
    kept.forEach(({ id }, index) => {
      const at = index + 1
      expect(getInputDraft(test.db, id)).toEqual({ text: `Draft ${String(at)}`, images: at % 2 === 0 ? [PNG] : [] })
    })
    expect(draftRows()).toBe(49)
    expect(draftImageRows()).toBe(24)
  })
})

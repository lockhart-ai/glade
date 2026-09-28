import { describe, expect, it } from 'vitest'
import { unsavedFiles, withFileEdit, withoutTask, type EditSession, type FileEdits, type OpenFileEdit } from './unsaved'

/** An editor that does nothing: these functions only keep track of them. */
const SESSION: EditSession = {
  editState: { unsaved: false, changedOnDisk: false },
  text: () => '',
  show: () => () => undefined,
  markLine: () => undefined,
  receive: () => true,
  reload: () => true,
  keepMine: () => undefined,
  markSaved: () => undefined,
}

function edit(unsaved: boolean): OpenFileEdit {
  return { session: SESSION, unsaved, changedOnDisk: false }
}

describe('withFileEdit', () => {
  it('adds a file’s edit under its task, keeping the others and their order', () => {
    let edits: FileEdits = {}
    edits = withFileEdit(edits, { taskId: 't1', path: 'a.md' }, edit(false))
    edits = withFileEdit(edits, { taskId: 't2', path: 'c.md' }, edit(true))
    edits = withFileEdit(edits, { taskId: 't1', path: 'b.md' }, edit(true))
    // Updating a file's edit keeps it, and its task, where they were.
    edits = withFileEdit(edits, { taskId: 't1', path: 'a.md' }, edit(true))

    expect(Object.keys(edits)).toEqual(['t1', 't2'])
    expect(Object.keys(edits.t1 ?? {})).toEqual(['a.md', 'b.md'])
    expect(edits.t1?.['a.md']?.unsaved).toBe(true)
  })

  it('takes a file out, and its task once it has none', () => {
    let edits: FileEdits = {}
    edits = withFileEdit(edits, { taskId: 't1', path: 'a.md' }, edit(true))
    edits = withFileEdit(edits, { taskId: 't1', path: 'b.md' }, edit(true))

    edits = withFileEdit(edits, { taskId: 't1', path: 'a.md' }, undefined)
    expect(Object.keys(edits.t1 ?? {})).toEqual(['b.md'])
    edits = withFileEdit(edits, { taskId: 't1', path: 'b.md' }, undefined)
    expect(edits).toEqual({})
    // Taking out a file that isn't there changes nothing.
    expect(withFileEdit(edits, { taskId: 't9', path: 'x.md' }, undefined)).toEqual({})
  })
})

describe('withoutTask', () => {
  it('drops a task’s files, and leaves edits without it as they are', () => {
    const edits = withFileEdit(
      withFileEdit({}, { taskId: 't1', path: 'a.md' }, edit(true)),
      { taskId: 't2', path: 'b.md' },
      edit(true),
    )

    expect(Object.keys(withoutTask(edits, 't1'))).toEqual(['t2'])
    expect(withoutTask(edits, 't9')).toBe(edits)
  })
})

describe('unsavedFiles', () => {
  it('lists the files with unsaved edits, a task’s or every task’s, in the order they opened', () => {
    let edits: FileEdits = {}
    edits = withFileEdit(edits, { taskId: 't1', path: 'a.md' }, edit(true))
    edits = withFileEdit(edits, { taskId: 't1', path: 'b.md' }, edit(false))
    edits = withFileEdit(edits, { taskId: 't2', path: 'c.md' }, edit(true))

    expect(unsavedFiles(edits)).toEqual([
      { taskId: 't1', path: 'a.md' },
      { taskId: 't2', path: 'c.md' },
    ])
    expect(unsavedFiles(edits, 't2')).toEqual([{ taskId: 't2', path: 'c.md' }])
    expect(unsavedFiles(edits, 't9')).toEqual([])
  })
})

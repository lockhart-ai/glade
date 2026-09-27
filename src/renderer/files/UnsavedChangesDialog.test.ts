import { describe, expect, it } from 'vitest'
import { unsavedMessage, unsavedQuestion } from './UnsavedChangesDialog'
import { UnsavedReason } from './unsaved'

const ONE = [{ taskId: 't1', path: 'docs/rate-limits.md' }]
const THREE = [
  { taskId: 't1', path: 'docs/a.md' },
  { taskId: 't1', path: 'src/b.ts' },
  { taskId: 't2', path: 'c.py' },
]

describe('the unsaved edits prompt’s words', () => {
  it('asks about what was about to happen', () => {
    expect(unsavedQuestion({ reason: UnsavedReason.CloseFile, files: ONE })).toBe('Save your edits to rate-limits.md?')
    expect(unsavedQuestion({ reason: UnsavedReason.SwitchTask, files: ONE })).toBe(
      'Save your edits before switching task?',
    )
    expect(unsavedQuestion({ reason: UnsavedReason.CloseWindow, files: ONE })).toBe(
      'Save your edits before closing the window?',
    )
    expect(unsavedQuestion({ reason: UnsavedReason.Quit, files: THREE })).toBe('Save your edits before quitting?')
  })

  it('names the files with unsaved edits', () => {
    expect(unsavedMessage({ reason: UnsavedReason.Quit, files: ONE })).toBe(
      'rate-limits.md has unsaved edits. Discard drops them; the file on disk stays as it is.',
    )
    expect(unsavedMessage({ reason: UnsavedReason.Quit, files: THREE.slice(0, 2) })).toBe(
      'a.md and b.ts have unsaved edits. Discard drops them; the files on disk stay as they are.',
    )
    expect(unsavedMessage({ reason: UnsavedReason.Quit, files: THREE })).toBe(
      'a.md, b.ts and c.py have unsaved edits. Discard drops them; the files on disk stay as they are.',
    )
  })
})

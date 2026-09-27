import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileContentKind, type FileContent } from '../../shared/domain'
import { differingSpan, FileSession, isEditable } from './fileSession'
import type { FileEditState } from './unsaved'

function text(value: string, truncated = false): FileContent {
  return { kind: FileContentKind.Text, text: value, truncated, size: value.length }
}

const MISSING: FileContent = { kind: FileContentKind.Missing }

/** Whether CodeMirror takes this for a Mac, where its Mod key is ⌘. */
const MAC = navigator.platform.includes('Mac')

/** A session for `start`, and every edit state it reported. */
function session(start: string): { file: FileSession; reported: FileEditState[] } {
  const reported: FileEditState[] = []
  const file = new FileSession({ text: start, language: null, label: 'notes.txt contents' }, (state) => {
    reported.push(state)
  })
  return { file, reported }
}

/** Types into a session's editor, as the keyboard would, while it shows. */
function type(view: EditorView, typed: string, at = 0): void {
  view.dispatch({ changes: { from: at, insert: typed }, userEvent: 'input.type' })
}

const hosts: HTMLElement[] = []

/** An element to show an editor in. */
function host(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  hosts.push(element)
  return element
}

/** The editor showing in `element`. */
function viewIn(element: HTMLElement): EditorView {
  const dom = element.querySelector('.cm-editor')
  const found = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
  if (found === null) throw new Error('No editor showing')
  return found
}

afterEach(() => {
  for (const element of hosts.splice(0)) element.remove()
})

describe('isEditable', () => {
  it('is text shown whole: not text too large to show whole, binary or missing', () => {
    expect(isEditable(text('a'))).toBe(true)
    expect(isEditable(text('a', true))).toBe(false)
    expect(isEditable({ kind: FileContentKind.Binary, size: 3 })).toBe(false)
    expect(isEditable(MISSING)).toBe(false)
  })
})

describe('differingSpan', () => {
  it('is the one change between what two texts start and end with', () => {
    expect(differingSpan('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' })
    expect(differingSpan('abc', 'abc')).toEqual({ from: 3, to: 3, insert: '' })
    expect(differingSpan('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' })
    expect(differingSpan('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' })
    expect(differingSpan('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
  })
})

describe('FileSession', () => {
  it('starts from the file’s text, nothing unsaved', () => {
    const { file, reported } = session('one\ntwo\n')

    expect(file.text()).toBe('one\ntwo\n')
    expect(file.editState).toEqual({ unsaved: false, changedOnDisk: false })
    expect(reported).toEqual([])
  })

  it('reports unsaved edits as the text leaves the file’s and comes back, once for each change', () => {
    const { file, reported } = session('one\n')
    const element = host()
    file.show(element)
    type(viewIn(element), 'x')
    type(viewIn(element), 'y')
    expect(file.editState.unsaved).toBe(true)
    undo(viewIn(element))
    undo(viewIn(element))

    expect(file.text()).toBe('one\n')
    expect(reported).toEqual([
      { unsaved: true, changedOnDisk: false },
      { unsaved: false, changedOnDisk: false },
    ])
  })

  it('measures edits against the text last saved', () => {
    const { file } = session('one\n')
    const element = host()
    file.show(element)
    type(viewIn(element), 'x')

    file.markSaved('xone\n')
    expect(file.editState.unsaved).toBe(false)
    // The same length as what was saved, but other text.
    viewIn(element).dispatch({ changes: { from: 0, to: 1, insert: 'y' } })
    expect(file.editState.unsaved).toBe(true)
  })

  it('keeps a file’s Windows line endings, and its text length as saved', () => {
    const { file } = session('one\r\ntwo\r\n')
    const element = host()
    file.show(element)

    expect(file.state.doc.lines).toBe(3)
    type(viewIn(element), '!', file.state.doc.line(2).to)

    expect(file.text()).toBe('one\r\ntwo!\r\n')
    expect(file.editState.unsaved).toBe(true)
  })

  it('keeps its text, selection and undo history between showings, and hides only the editor it showed', () => {
    const { file } = session('one\n')
    const first = host()
    const hide = file.show(first)
    type(viewIn(first), 'x')
    hide()
    expect(first.querySelector('.cm-editor')).toBeNull()
    // Hiding again, or an old editor's hide after a new one shows, changes nothing.
    hide()

    const second = host()
    const hideSecond = file.show(second)
    hide()
    expect(viewIn(second).state.doc.toString()).toBe('xone\n')
    undo(viewIn(second))
    expect(file.text()).toBe('one\n')
    hideSecond()
  })

  it('shows in one place at a time', () => {
    const { file } = session('one\n')
    const first = host()
    const second = host()

    file.show(first)
    file.show(second)

    expect(first.querySelector('.cm-editor')).toBeNull()
    expect(second.querySelector('.cm-editor')).not.toBeNull()
  })

  it('lets the keys it answers go no further, and the rest on to the window', () => {
    const { file } = session('one\n')
    const element = host()
    file.show(element)
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    try {
      const content = viewIn(element).contentDOM
      // ⌘F opens its find bar; ⌘P is the window's. (CodeMirror's ⌘ is Ctrl off a Mac, as jsdom is.)
      const mod = MAC ? { metaKey: true } : { ctrlKey: true }
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ...mod, bubbles: true, cancelable: true }))
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ...mod, bubbles: true, cancelable: true }))
    } finally {
      window.removeEventListener('keydown', heard)
    }

    expect(heard).toHaveBeenCalledOnce()
    expect(heard.mock.calls[0]?.[0]).toMatchObject({ key: 'p' })
    expect(element.querySelector('[aria-label="Find in file"]')).not.toBeNull()
  })

  it('marks a line, and moves the mark with the text; null clears it', () => {
    const { file } = session('one\ntwo\nthree\n')
    const element = host()
    file.show(element)

    file.markLine(2)
    expect(element.querySelector('.cm-line.cm-glade-marked')?.textContent).toBe('two')
    type(viewIn(element), 'zero\n')
    expect(element.querySelector('.cm-line.cm-glade-marked')?.textContent).toBe('two')

    file.markLine(null)
    expect(element.querySelector('.cm-glade-marked')).toBeNull()
  })

  it('marks a line while hidden, to show when it shows; a line past the end marks the last', () => {
    const { file } = session('one\ntwo')

    file.markLine(9)
    const element = host()
    file.show(element)

    expect(element.querySelector('.cm-line.cm-glade-marked')?.textContent).toBe('two')
    file.markLine(0)
    expect(element.querySelector('.cm-line.cm-glade-marked')?.textContent).toBe('one')
  })

  describe('reading the file again', () => {
    it('changes nothing when the disk has what the edits are measured against', () => {
      const { file, reported } = session('one\n')

      expect(file.receive(text('one\n'))).toBe(true)
      expect(file.text()).toBe('one\n')
      expect(reported).toEqual([])
    })

    it('takes new text quietly with nothing unsaved, as an edit you can’t undo', () => {
      const { file, reported } = session('one\ntwo\n')
      const element = host()
      file.show(element)

      expect(file.receive(text('one\n2\n'))).toBe(true)

      expect(file.text()).toBe('one\n2\n')
      expect(reported).toEqual([])
      undo(viewIn(element))
      expect(file.text()).toBe('one\n2\n')
    })

    it('takes new text quietly while hidden too', () => {
      const { file } = session('one\ntwo\n')
      const element = host()
      file.show(element)()

      file.receive(text('one\n2\n'))
      file.show(element)

      expect(viewIn(element).state.doc.toString()).toBe('one\n2\n')
    })

    it('answers false, with nothing unsaved, when the disk has nothing it can show', () => {
      const { file } = session('one\n')

      expect(file.receive(MISSING)).toBe(false)
      expect(file.receive(text('big', true))).toBe(false)
    })

    it('waits for Reload or Keep mine under unsaved edits, and a disk back where it was clears that', () => {
      const { file, reported } = session('one\n')
      const element = host()
      file.show(element)
      type(viewIn(element), 'x')

      expect(file.receive(text('two\n'))).toBe(true)
      expect(file.text()).toBe('xone\n')
      expect(file.editState).toEqual({ unsaved: true, changedOnDisk: true })
      expect(file.receive(text('one\n'))).toBe(true)
      expect(file.editState).toEqual({ unsaved: true, changedOnDisk: false })
      expect(reported.at(-1)).toEqual({ unsaved: true, changedOnDisk: false })
    })
  })

  describe('Reload and Keep mine', () => {
    it('Reload takes the disk’s text, dropping the edits', () => {
      const { file } = session('one\n')
      const element = host()
      file.show(element)
      type(viewIn(element), 'x')
      file.receive(text('two\n'))

      expect(file.reload()).toBe(true)

      expect(file.text()).toBe('two\n')
      expect(file.editState).toEqual({ unsaved: false, changedOnDisk: false })
    })

    it('Reload answers false when the disk has nothing it can show, and does nothing with no change to take', () => {
      const { file } = session('one\n')
      expect(file.reload()).toBe(true)

      const element = host()
      file.show(element)
      type(viewIn(element), 'x')
      file.receive(MISSING)
      expect(file.reload()).toBe(false)
    })

    it('Keep mine keeps the edits, measured against the disk’s text from then', () => {
      const { file } = session('one\n')
      const element = host()
      file.show(element)
      type(viewIn(element), 'x')
      file.receive(text('two\n'))

      file.keepMine()

      expect(file.text()).toBe('xone\n')
      expect(file.editState).toEqual({ unsaved: true, changedOnDisk: false })
      // Typing back to the disk's text leaves nothing unsaved.
      viewIn(element).dispatch({ changes: { from: 0, to: 5, insert: 'two\n' } })
      expect(file.editState.unsaved).toBe(false)
    })

    it('Keep mine over a file that went keeps the edits unsaved, whatever they are', () => {
      const { file } = session('one\n')
      const element = host()
      file.show(element)
      type(viewIn(element), 'x')
      file.receive(MISSING)

      file.keepMine()
      viewIn(element).dispatch({ changes: { from: 0, to: 1 } })

      expect(file.text()).toBe('one\n')
      expect(file.editState).toEqual({ unsaved: true, changedOnDisk: false })
      // With no change to take, it does nothing.
      file.keepMine()
      expect(file.editState).toEqual({ unsaved: true, changedOnDisk: false })
    })

    it('saving clears the bar too', () => {
      const { file } = session('one\n')
      const element = host()
      file.show(element)
      type(viewIn(element), 'x')
      file.receive(text('two\n'))

      file.markSaved('xone\n')

      expect(file.editState).toEqual({ unsaved: false, changedOnDisk: false })
    })
  })
})

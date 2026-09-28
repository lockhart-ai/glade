import { getSearchQuery, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorState } from './editorSetup'

const views: EditorView[] = []

/** An editor on `text` with its find bar open, and the bar's field and buttons. */
function findIn(text: string) {
  const view = new EditorView({ state: createEditorState({ text, language: null, label: 'a.txt contents' }) })
  document.body.append(view.dom)
  views.push(view)
  openSearchPanel(view)
  const bar = view.dom.querySelector('[role="search"]')
  const field = bar?.querySelector('input')
  if (!(bar instanceof HTMLElement) || !(field instanceof HTMLInputElement)) throw new Error('No find bar')
  const button = (name: string): HTMLButtonElement => {
    const found = bar.querySelector(`button[aria-label="${name}"]`)
    if (!(found instanceof HTMLButtonElement)) throw new Error(`No ${name}`)
    return found
  }
  return { view, bar, field, button }
}

function typeIn(field: HTMLInputElement, text: string): void {
  field.value = text
  field.dispatchEvent(new Event('input'))
}

function key(field: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  field.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy()
    view.dom.remove()
  }
})

describe('the find bar', () => {
  it('has a Find field and previous, next and close buttons, each named', () => {
    const { field, button } = findIn('limit\n')

    expect(field).toHaveAttribute('aria-label', 'Find in file')
    expect(field).toHaveAttribute('placeholder', 'Find')
    for (const name of ['Previous match', 'Next match', 'Close find'])
      expect(button(name)).toHaveAttribute('title', name)
  })

  it('finds as you type; ↵ goes to the next match and ⇧↵ to the one before', () => {
    const { view, field } = findIn('limit one\nlimit two\nlimit three\n')

    typeIn(field, 'limit')
    expect(getSearchQuery(view.state).search).toBe('limit')

    expect(key(field, { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(view.state.selection.main.from).toBe(0)
    key(field, { key: 'Enter' })
    expect(view.state.selection.main.from).toBe(10)
    key(field, { key: 'Enter', shiftKey: true })
    expect(view.state.selection.main.from).toBe(0)
  })

  it('goes to matches with its buttons, and closes with its close button', () => {
    const { view, field, button } = findIn('a limit\nlimit\n')
    typeIn(field, 'limit')

    button('Next match').click()
    expect(view.state.selection.main.from).toBe(2)
    button('Next match').click()
    button('Previous match').click()
    expect(view.state.selection.main.from).toBe(2)
    button('Close find').click()
    expect(searchPanelOpen(view.state)).toBe(false)
  })

  it('closes on Esc; ⌘F in the field selects what’s in it; other keys are the field’s', () => {
    const { view, field } = findIn('limit\n')
    typeIn(field, 'lim')

    expect(key(field, { key: 'f', metaKey: true }).defaultPrevented).toBe(true)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(3)
    expect(key(field, { key: 'a' }).defaultPrevented).toBe(false)
    key(field, { key: 'Escape' })
    expect(searchPanelOpen(view.state)).toBe(false)
  })

  it('shows the selection as the search when ⌘F opens it again', () => {
    const { view, field } = findIn('rate limit\n')
    view.dispatch({ selection: EditorSelection.range(5, 10) })

    openSearchPanel(view)

    expect(field.value).toBe('limit')
  })
})

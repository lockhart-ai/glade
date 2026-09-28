/**
 * The editor's find bar (⌘F), in Glade's own chrome rather than CodeMirror's: a Find field, previous and next match,
 * and close. Typing highlights every match; ↵ goes to the next one and ⇧↵ to the one before; Esc closes it and puts
 * the focus back in the file. No replace, no regular expressions: a plain find, as the Files tab needs.
 */
import { icon, type IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faChevronDown, faChevronUp, faXmark } from '@fortawesome/free-solid-svg-icons'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view'
import styles from './FindPanel.module.css'

/** An icon-only button of the bar, named by `label`, that runs `run` on the editor. */
function button(label: string, glyph: IconDefinition, run: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = styles.button ?? ''
  element.setAttribute('aria-label', label)
  element.title = label
  element.append(...Array.from(icon(glyph).node))
  element.addEventListener('click', run)
  return element
}

/** The find bar of an editor: CodeMirror's search panel (`search({ createPanel })`). */
export function findPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = styles.find ?? ''
  dom.setAttribute('role', 'search')

  const field = document.createElement('input')
  field.type = 'text'
  field.className = styles.field ?? ''
  field.placeholder = 'Find'
  field.setAttribute('aria-label', 'Find in file')
  // CodeMirror focuses and selects the field marked so when ⌘F asks for the bar while it's already open.
  field.setAttribute('main-field', 'true')
  field.spellcheck = false
  field.value = getSearchQuery(view.state).search
  field.addEventListener('input', () => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: field.value })) })
  })
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
    } else if (event.key === 'f' && event.metaKey) {
      // ⌘F again selects what's in the field, rather than searching the tasks.
      event.preventDefault()
      field.select()
    }
  })

  dom.append(
    field,
    button('Previous match', faChevronUp, () => findPrevious(view)),
    button('Next match', faChevronDown, () => findNext(view)),
    button('Close find', faXmark, () => closeSearchPanel(view)),
  )

  return {
    dom,
    top: true,
    mount() {
      field.select()
    },
    update(update: ViewUpdate) {
      // ⌘F with text selected searches for it: show it.
      const { search } = getSearchQuery(update.state)
      if (search !== field.value) field.value = search
    },
  }
}

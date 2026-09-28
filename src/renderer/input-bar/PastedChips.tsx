import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PastedBlock } from '../../shared/domain'
import { pastedBlockLabel } from '../chat/PastedBlockRow'
import { Button, ButtonVariant, Textarea } from '../components'
import styles from './PastedChips.module.css'

export interface PastedChipsProps {
  /** The draft's pasted blocks, in the order their tokens appear among the typed text. */
  readonly blocks: readonly PastedBlock[]
  /** The block being expanded to view or edit, if any. */
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onRemove: (id: string) => void
  /** Saves an edit to a block's text; its token is regenerated to match its new line count. */
  readonly onSave: (id: string, text: string) => void
}

/**
 * The text pasted into the message being written, as compact chips above the field (`docs/design/html/33-pasted-
 * content.html`), each "Pasted text · N lines" with a remove button and a click to expand or edit — never the pasted
 * text itself dumped into the field, just a short inline token standing for it there. Nothing when there are none.
 */
export function PastedChips({
  blocks,
  expandedId,
  onToggleExpand,
  onRemove,
  onSave,
}: PastedChipsProps): React.JSX.Element | null {
  if (blocks.length === 0) return null
  return (
    <ul className={styles.list} aria-label="Pasted text">
      {blocks.map((block) => (
        <li key={block.id} className={styles.chip}>
          {expandedId === block.id ? (
            <PastedChipEditor
              block={block}
              onSave={(text) => {
                onSave(block.id, text)
              }}
              onCancel={() => {
                onToggleExpand(block.id)
              }}
            />
          ) : (
            <>
              <button
                type="button"
                className={styles.summary}
                aria-expanded={false}
                onClick={() => {
                  onToggleExpand(block.id)
                }}
              >
                {pastedBlockLabel(block)}
              </button>
              <Button
                variant={ButtonVariant.Icon}
                icon={faXmark}
                aria-label="Remove pasted text"
                title="Remove pasted text"
                onClick={() => {
                  onRemove(block.id)
                }}
              />
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

interface PastedChipEditorProps {
  readonly block: PastedBlock
  readonly onSave: (text: string) => void
  readonly onCancel: () => void
}

/** A pasted block expanded in place: its text, editable, above Save and the field it replaces while open. */
function PastedChipEditor({ block, onSave, onCancel }: PastedChipEditorProps): React.JSX.Element {
  const [text, setText] = useState(block.text)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [])

  const save = (): void => {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed === block.text) onCancel()
    else onSave(text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onCancel()
  }

  return (
    <div className={styles.editor}>
      <button type="button" className={styles.summary} aria-expanded={true} onClick={onCancel}>
        {pastedBlockLabel(block)}
      </button>
      <Textarea
        ref={field}
        label="Pasted text"
        className={styles.editorField}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <div className={styles.editorActions}>
        <Button variant={ButtonVariant.Icon} icon={faCheck} aria-label="Save pasted text" title="Save" onClick={save} />
        <Button
          variant={ButtonVariant.Icon}
          icon={faXmark}
          aria-label="Cancel editing pasted text"
          title="Cancel"
          onClick={onCancel}
        />
      </div>
    </div>
  )
}

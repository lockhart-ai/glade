import { useLayoutEffect, useRef } from 'react'
import type { EditSession } from './unsaved'
import styles from './SourceEditor.module.css'

export interface SourceEditorProps {
  /** The file being edited, whose editor this shows. */
  session: EditSession
  /** A line to mark and scroll to, from 1; null for none. */
  focusLine: number | null
  /** Changes with every request to show `focusLine`, so asking for the same line again scrolls to it again. */
  focusRequest: number
}

/**
 * A workspace file's source, editable (`./editorSetup`): it looks just as the read-only `SourceView` does, with a caret.
 * It shows the file's editor as it was left, with `focusLine` marked and scrolled into view.
 */
export function SourceEditor({ session, focusLine, focusRequest }: SourceEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    /* v8 ignore next -- the host is always mounted when a layout effect runs */
    if (host.current === null) return
    return session.show(host.current)
  }, [session])

  useLayoutEffect(() => {
    session.markLine(focusLine)
  }, [session, focusLine, focusRequest])

  return <div ref={host} className={styles.editor} data-testid="editor" />
}

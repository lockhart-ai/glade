import { fileName } from '../../shared/files'
import { ConfirmDialog, useModalPresence, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { UnsavedChoice, UnsavedReason, type UnsavedPrompt } from './unsaved'

/** What the prompt asks, for what was about to happen. */
export function unsavedQuestion({ reason, files }: UnsavedPrompt): string {
  switch (reason) {
    case UnsavedReason.CloseFile:
      return `Save your edits to ${files.map(({ path }) => fileName(path)).join(', ')}?`
    case UnsavedReason.SwitchTask:
      return 'Save your edits before switching task?'
    case UnsavedReason.CloseWindow:
      return 'Save your edits before closing the window?'
    case UnsavedReason.Quit:
      return 'Save your edits before quitting?'
  }
}

/** "a.md", "a.md and b.ts", "a.md, b.ts and c.py". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

/** Which files have unsaved edits, and what Discard does. */
export function unsavedMessage({ files }: UnsavedPrompt): string {
  const names = files.map(({ path }) => fileName(path))
  return files.length === 1
    ? `${listed(names)} has unsaved edits. Discard drops them; the file on disk stays as it is.`
    : `${listed(names)} have unsaved edits. Discard drops them; the files on disk stay as they are.`
}

/**
 * Asks Save / Discard / Cancel about unsaved edits in the Files tab (`unsavedPrompt`): before closing a file's tab,
 * switching task, closing the window or quitting. Save saves each file and goes ahead; a file that can't be saved
 * shows a toast, and nothing goes ahead. Discard drops the edits and goes ahead; Cancel, Esc or a click outside stays.
 * Must be used under a `ToastProvider`.
 */
export function UnsavedChangesDialog(): React.JSX.Element | null {
  const prompt = useGladeStore((state) => state.unsavedPrompt)
  const answer = useGladeStore((state) => state.answerUnsavedPrompt)
  const toast = useToast()
  useModalPresence(prompt !== null)

  if (prompt === null) return null

  const choose = (choice: UnsavedChoice): void => {
    answer(choice).catch((error: unknown) => {
      toast.show({ message: `Couldn’t save: ${describeFailure(error)}` })
    })
  }

  return (
    <ConfirmDialog
      open
      title={unsavedQuestion(prompt)}
      message={unsavedMessage(prompt)}
      confirmLabel="Save"
      alternative={{
        label: 'Discard',
        onSelect: () => {
          choose(UnsavedChoice.Discard)
        },
      }}
      onConfirm={() => {
        choose(UnsavedChoice.Save)
      }}
      onCancel={() => {
        choose(UnsavedChoice.Cancel)
      }}
    />
  )
}

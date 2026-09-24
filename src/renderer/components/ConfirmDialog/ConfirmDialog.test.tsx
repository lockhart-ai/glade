import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ButtonVariant } from '../Button/Button'
import buttonStyles from '../Button/Button.module.css'
import { moduleClass } from '../moduleClass'
import { settleFloating } from '../settleFloating'
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog'

const QUESTION = 'Delete “Fix flaky login test”?'

async function renderDialog(props: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const view = render(
    <>
      <button type="button">Elsewhere</button>
      <ConfirmDialog
        open
        title={QUESTION}
        message="Files on disk aren't touched."
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    </>,
  )
  await settleFloating()
  return { ...view, onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('asks its question as a modal alert dialog, with the focus on Cancel', async () => {
    await renderDialog()

    const dialog = screen.getByRole('alertdialog', { name: QUESTION })
    expect(dialog).toHaveAccessibleDescription("Files on disk aren't touched.")
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass(moduleClass(buttonStyles, ButtonVariant.Primary))
  })

  it('makes the confirm button pink when confirming destroys something', async () => {
    await renderDialog({ destructive: true })

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass(moduleClass(buttonStyles, ButtonVariant.Danger))
  })

  it('confirms only with the confirm button', async () => {
    const { onConfirm, onCancel } = await renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels with Cancel, Esc, or a click outside', async () => {
    const { onConfirm, onCancel } = await renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    fireEvent.mouseDown(document.body)

    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing while closed', async () => {
    await renderDialog({ open: false })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

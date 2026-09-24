import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { FloatingPortal } from '@floating-ui/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, ButtonSize, ButtonVariant } from '../Button/Button'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import styles from './Toast.module.css'

/** How long a toast stays up unless it says otherwise, in milliseconds. */
export const DEFAULT_TOAST_TIMEOUT = 6000

/** A button on a toast, e.g. Undo. Choosing it also dismisses the toast. */
export interface ToastAction {
  label: string
  onAction: () => void
}

/** What to show in a toast. */
export interface ToastOptions {
  message: string
  /** An icon before the message, e.g. a check. */
  icon?: IconDefinition
  action?: ToastAction
  /** Milliseconds until the toast dismisses itself. Defaults to `DEFAULT_TOAST_TIMEOUT`. */
  timeout?: number
}

/** Shows and dismisses toasts. Get it with `useToast()` inside a `ToastProvider`. */
export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (toast: ToastOptions) => number
  dismiss: (id: number) => void
}

export interface ToastProviderProps {
  children: ReactNode
  /** Classes for the toast region, e.g. to move it above the composer. */
  className?: string
}

interface ShownToast extends ToastOptions {
  id: number
}

const ToastContext = createContext<ToastApi | null>(null)

/** The toast API from the nearest `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be used inside a ToastProvider')
  return api
}

/**
 * Holds the toasts for everything inside it and shows them in a region at the bottom of the window, newest last.
 * Each toast dismisses itself after its timeout.
 */
export function ToastProvider({ children, className }: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly ShownToast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback((toast: ToastOptions): number => {
    const id = nextId.current
    nextId.current += 1
    setToasts((current) => [...current, { ...toast, id }])
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <FloatingPortal>
        <div
          role="region"
          aria-label="Notifications"
          aria-live="polite"
          className={classNames(styles.region, className)}
        >
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </FloatingPortal>
    </ToastContext.Provider>
  )
}

interface ToastProps {
  toast: ShownToast
  onDismiss: (id: number) => void
}

function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const { id, message, icon, action, timeout = DEFAULT_TOAST_TIMEOUT } = toast

  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(id)
    }, timeout)
    return () => {
      clearTimeout(timer)
    }
  }, [id, timeout, onDismiss])

  return (
    <div className={styles.toast}>
      {icon !== undefined && <Icon icon={icon} size={IconSize.Medium} className={styles.icon} />}
      <span className={styles.message}>{message}</span>
      {action !== undefined && (
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          onClick={() => {
            onDismiss(id)
            action.onAction()
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}

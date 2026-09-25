import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, ButtonSize, ButtonVariant } from '../Button/Button'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import { useOverlayRef } from '../overlays'
import { motionDuration } from '../../motion'
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
  /** Dismissed, and fading out: it goes once it has. */
  leaving: boolean
}

const ToastContext = createContext<ToastApi | null>(null)

/** Registers a `ToastAnchor`'s element with its provider; returns the call that unregisters it. */
type RegisterAnchor = (element: HTMLElement) => () => void

const ToastAnchorContext = createContext<RegisterAnchor | null>(null)

export interface ToastAnchorProps {
  /** Classes for the anchor, e.g. to set where the toasts sit relative to it. */
  className?: string
}

/**
 * Where the nearest `ToastProvider` shows its toasts: they stand centred on the anchor, stacked upwards from its
 * top edge. Put it in a positioned container, e.g. on the input bar so the toasts sit above it, centred on the chat
 * column. While several anchors are mounted, the latest one wins; with none, the toasts sit at the bottom of the window.
 */
export function ToastAnchor({ className }: ToastAnchorProps): React.JSX.Element {
  const register = useContext(ToastAnchorContext)
  if (register === null) throw new Error('ToastAnchor must be used inside a ToastProvider')
  const ref = useCallback((element: HTMLDivElement) => register(element), [register])
  return <div ref={ref} className={classNames(styles.anchor, className)} data-testid="toast-anchor" />
}

/** The toast API from the nearest `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be used inside a ToastProvider')
  return api
}

/**
 * Holds the toasts for everything inside it and shows them in a region, newest last: at the latest mounted
 * `ToastAnchor`, or at the bottom of the window while there is none. Each toast dismisses itself after its timeout.
 * Toasts rise and fade in, and fade out when dismissed.
 */
export function ToastProvider({ children, className }: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly ShownToast[]>([])
  const nextId = useRef(1)
  // The timers that remove toasts once they've faded out, to cancel if the provider goes first.
  const removals = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const timers = removals.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])

  const remove = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  // A dismissed toast fades out, then goes; at once with Reduce motion on.
  const dismiss = useCallback(
    (id: number): void => {
      const duration = motionDuration()
      if (duration === 0) {
        remove(id)
        return
      }
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)))
      const timer = setTimeout(() => {
        removals.current.delete(timer)
        remove(id)
      }, duration)
      removals.current.add(timer)
    },
    [remove],
  )

  const show = useCallback((toast: ToastOptions): number => {
    const id = nextId.current
    nextId.current += 1
    setToasts((current) => [...current, { ...toast, id, leaving: false }])
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  const [anchors, setAnchors] = useState<readonly HTMLElement[]>([])
  const registerAnchor = useCallback<RegisterAnchor>((element) => {
    setAnchors((current) => [...current, element])
    return () => {
      setAnchors((current) => current.filter((anchor) => anchor !== element))
    }
  }, [])
  const anchor = anchors.at(-1)

  return (
    <ToastContext.Provider value={api}>
      <ToastAnchorContext.Provider value={registerAnchor}>{children}</ToastAnchorContext.Provider>
      {createPortal(
        <div
          role="region"
          aria-label="Notifications"
          aria-live="polite"
          className={classNames(styles.region, anchor === undefined ? styles.window : styles.anchored, className)}
        >
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        anchor ?? document.body,
      )}
    </ToastContext.Provider>
  )
}

interface ToastProps {
  toast: ShownToast
  onDismiss: (id: number) => void
}

function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const { id, message, icon, action, timeout = DEFAULT_TOAST_TIMEOUT, leaving } = toast
  const overlay = useOverlayRef()

  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(id)
    }, timeout)
    return () => {
      clearTimeout(timer)
    }
  }, [id, timeout, onDismiss])

  return (
    <div ref={overlay} className={classNames(styles.toast, leaving && styles.leaving)} inert={leaving}>
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

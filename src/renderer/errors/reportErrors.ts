/**
 * Sends the window's errors to the main log (`docs/logs.md`) through the bridge (`log.rendererError`): uncaught errors,
 * unhandled rejections, and the errors React reports, caught by an error boundary or not. The renderer's own console
 * goes nowhere once the app is packaged, so without this they'd be lost.
 */
import type { ErrorInfo, RootOptions } from 'react-dom/client'
import {
  CommandName,
  MAX_RENDERER_ERROR_TEXT,
  RendererErrorKind,
  type GladeBridge,
  type LogRendererErrorRequest,
} from '../../shared/bridge'

/** Sends one error to the main log. Never throws, and never reports its own failure: that could go round forever. */
export type ReportError = (kind: RendererErrorKind, error: unknown, extra?: ErrorExtra) => void

/** What else is known about an error, besides the error itself. */
export interface ErrorExtra {
  readonly componentStack?: string | null
  readonly source?: string | null
}

function clip(text: string): string {
  return text.slice(0, MAX_RENDERER_ERROR_TEXT)
}

/** An error, or whatever was thrown or rejected with, as the request that logs it. */
export function rendererError(
  kind: RendererErrorKind,
  error: unknown,
  { componentStack = null, source = null }: ErrorExtra = {},
): LogRendererErrorRequest {
  const isError = error instanceof Error
  const message = isError ? `${error.name}: ${error.message}` : String(error)
  const stack = isError && error.stack !== undefined ? clip(error.stack) : null
  return {
    kind,
    message: clip(message),
    stack,
    componentStack: componentStack === null ? null : clip(componentStack),
    source: source === null ? null : clip(source),
  }
}

/** Reports errors to main over `bridge`. */
export function createErrorReporter(bridge: Pick<GladeBridge, 'invoke'>): ReportError {
  return (kind, error, extra) => {
    try {
      bridge.invoke(CommandName.LogRendererError, rendererError(kind, error, extra)).catch(() => undefined)
    } catch {
      // The bridge itself is broken: there's nowhere left to report to.
    }
  }
}

/** The part of `window` the reporter listens to. */
export interface ErrorEvents {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void
}

/** Reports the window's uncaught errors and unhandled rejections. */
export function reportWindowErrors(target: ErrorEvents, report: ReportError): void {
  target.addEventListener('error', (event) => {
    const source = event.filename === '' ? null : `${event.filename}:${String(event.lineno)}:${String(event.colno)}`
    report(RendererErrorKind.Error, event.error ?? event.message, { source })
  })
  target.addEventListener('unhandledrejection', (event) => {
    report(RendererErrorKind.UnhandledRejection, event.reason)
  })
}

/** React's component stack, if it has one. */
function componentStack(info: ErrorInfo): string | null {
  return info.componentStack ?? null
}

/**
 * The root's error callbacks: each reports what React caught, and how, and still shows it on the console as React
 * would, for the developer tools.
 */
export function reactErrorOptions(report: ReportError): RootOptions {
  const handle =
    (kind: RendererErrorKind) =>
    (error: unknown, info: ErrorInfo): void => {
      console.error(error)
      report(kind, error, { componentStack: componentStack(info) })
    }
  return {
    onUncaughtError: handle(RendererErrorKind.ReactUncaught),
    onCaughtError: handle(RendererErrorKind.ReactCaught),
    onRecoverableError: handle(RendererErrorKind.ReactRecoverable),
  }
}

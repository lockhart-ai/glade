import { Component, type ReactNode } from 'react'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandName,
  MAX_RENDERER_ERROR_TEXT,
  RendererErrorKind,
  type LogRendererErrorRequest,
} from '../../shared/bridge'
import { mountApp } from '../mount'
import { fakeBridge } from '../store/test-bridge'
import {
  createErrorReporter,
  reactErrorOptions,
  rendererError,
  reportWindowErrors,
  type ErrorEvents,
  type ReportError,
} from './reportErrors'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** A bridge to a main that keeps the errors it's sent. */
function mainKeepingErrors(): { errors: LogRendererErrorRequest[]; report: ReportError } {
  const errors: LogRendererErrorRequest[] = []
  const { bridge } = fakeBridge({ workspaces: [], tasks: [], uiState: [], rendererErrors: errors })
  return { errors, report: createErrorReporter(bridge) }
}

describe('rendererError', () => {
  it('sends an error as its name and message, with its stack', () => {
    const error = new TypeError('task is undefined')

    expect(rendererError(RendererErrorKind.Error, error, { source: 'index.js:10:4' })).toEqual({
      kind: RendererErrorKind.Error,
      message: 'TypeError: task is undefined',
      stack: error.stack,
      componentStack: null,
      source: 'index.js:10:4',
    })
  })

  it('sends anything else thrown as its text, with no stack', () => {
    expect(rendererError(RendererErrorKind.UnhandledRejection, 'offline')).toEqual({
      kind: RendererErrorKind.UnhandledRejection,
      message: 'offline',
      stack: null,
      componentStack: null,
      source: null,
    })
    const stackless = new Error('no stack')
    stackless.stack = undefined
    expect(rendererError(RendererErrorKind.Error, stackless).stack).toBeNull()
  })

  it('cuts text down to what main takes', () => {
    const long = 'x'.repeat(MAX_RENDERER_ERROR_TEXT + 5)
    const error = rendererError(RendererErrorKind.ReactCaught, long, { componentStack: long, source: long })

    expect(error.message).toHaveLength(MAX_RENDERER_ERROR_TEXT)
    expect(error.componentStack).toHaveLength(MAX_RENDERER_ERROR_TEXT)
    expect(error.source).toHaveLength(MAX_RENDERER_ERROR_TEXT)
  })
})

describe('createErrorReporter', () => {
  it('sends each error to main', async () => {
    const { errors, report } = mainKeepingErrors()

    report(RendererErrorKind.Error, new Error('boom'))

    await waitFor(() => {
      expect(errors).toEqual([expect.objectContaining({ kind: RendererErrorKind.Error, message: 'Error: boom' })])
    })
  })

  it('never throws, whether main refuses the error or the bridge itself is broken', async () => {
    const refusing = { invoke: vi.fn(() => Promise.reject(new Error('main is gone'))) }
    const broken = {
      invoke: vi.fn(() => {
        throw new Error('no bridge')
      }),
    }

    expect(() => {
      createErrorReporter(refusing)(RendererErrorKind.Error, 'x')
      createErrorReporter(broken)(RendererErrorKind.Error, 'x')
    }).not.toThrow()
    await Promise.resolve()
    expect(refusing.invoke).toHaveBeenCalledWith(CommandName.LogRendererError, expect.anything())
    expect(broken.invoke).toHaveBeenCalledOnce()
  })
})

describe('reportWindowErrors', () => {
  it("reports the window's uncaught errors, with where they came from", () => {
    const report = vi.fn<ReportError>()
    reportWindowErrors(window, report)
    const error = new Error('boom')

    window.dispatchEvent(new ErrorEvent('error', { error, message: 'boom', filename: 'app.js', lineno: 3, colno: 7 }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))

    expect(report.mock.calls).toEqual([
      [RendererErrorKind.Error, error, { source: 'app.js:3:7' }],
      [RendererErrorKind.Error, 'Script error.', { source: null }],
    ])
  })

  it('reports unhandled rejections, with what they rejected with', () => {
    // jsdom has no PromiseRejectionEvent, so the rejection comes from a stand-in for the window.
    const listeners = new Map<string, (event: PromiseRejectionEvent) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: PromiseRejectionEvent) => void) => {
        listeners.set(type, listener)
      },
    } as ErrorEvents
    const report = vi.fn<ReportError>()
    reportWindowErrors(target, report)

    listeners.get('unhandledrejection')?.({ reason: new Error('fetch failed') } as PromiseRejectionEvent)

    expect(report).toHaveBeenCalledExactlyOnceWith(RendererErrorKind.UnhandledRejection, new Error('fetch failed'))
  })
})

describe('reactErrorOptions', () => {
  it('reports what React caught with its component stack, and still shows it on the console', () => {
    const report = vi.fn<ReportError>()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const options = reactErrorOptions(report)
    const thrown = new Error('render failed')

    options.onCaughtError?.(thrown, { componentStack: '\n    at TaskHeader' })
    options.onUncaughtError?.(thrown, { componentStack: undefined })
    options.onRecoverableError?.(thrown, {})

    expect(report.mock.calls).toEqual([
      [RendererErrorKind.ReactCaught, thrown, { componentStack: '\n    at TaskHeader' }],
      [RendererErrorKind.ReactUncaught, thrown, { componentStack: null }],
      [RendererErrorKind.ReactRecoverable, thrown, { componentStack: null }],
    ])
    expect(error).toHaveBeenCalledTimes(3)
  })
})

/** A component that fails to render. */
function Broken(): ReactNode {
  throw new Error('TaskHeader fell over')
}

/** An error boundary that shows a fallback in place of what failed. */
class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? <p>Something went wrong.</p> : this.props.children
  }
}

describe('a mounted page', () => {
  it("sends main an error an error boundary caught, with React's component stack", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { errors, report } = mainKeepingErrors()
    const root = document.createElement('div')
    document.body.append(root)

    mountApp(
      root,
      <Boundary>
        <Broken />
      </Boundary>,
      reactErrorOptions(report),
    )

    await waitFor(() => {
      expect(errors).toEqual([
        expect.objectContaining({
          kind: RendererErrorKind.ReactCaught,
          message: 'Error: TaskHeader fell over',
          componentStack: expect.stringContaining('Broken') as unknown,
        }),
      ])
    })
  })

  it('sends main an error nothing caught', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { errors, report } = mainKeepingErrors()
    const root = document.createElement('div')
    document.body.append(root)

    mountApp(root, <Broken />, reactErrorOptions(report))

    await waitFor(() => {
      expect(errors).toEqual([
        expect.objectContaining({ kind: RendererErrorKind.ReactUncaught, message: 'Error: TaskHeader fell over' }),
      ])
    })
  })
})

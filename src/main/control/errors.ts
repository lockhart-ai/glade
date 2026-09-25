/**
 * Why a control call failed (`docs/control-api.md`, "Calls, results and errors"): a code another agent can act on, and
 * a message saying what went wrong.
 */
import { BridgeErrorCode } from '../../shared/bridge'
import { CommandFailure } from '../bridge/errors'

export enum ControlErrorCode {
  /** The input fails its schema: the message says which field and why. */
  InvalidInput = 'invalid_input',
  /** No such task, workspace or session. */
  NotFound = 'not_found',
  /** The change isn't one the task's state allows, e.g. marking a done task done. */
  InvalidTransition = 'invalid_transition',
  /** A task stopping, deleting or messaging itself. */
  Forbidden = 'forbidden',
  /** `delete_task` without `confirm: true`. */
  ConfirmRequired = 'confirm_required',
  /** Too many calls: `retryAfterMs` says when to try again. */
  RateLimited = 'rate_limited',
  /** The switch in Settings › Control is off. */
  Disabled = 'disabled',
  /** Something went wrong in Glade itself. */
  Internal = 'internal',
}

/** A failed call, as a client reads it: the error's JSON. */
export interface ControlErrorBody {
  readonly code: ControlErrorCode
  readonly message: string
  /** How long to wait before calling again, for `rate_limited`. */
  readonly retryAfterMs?: number
}

/** A call that failed for a reason the caller can act on. */
export class ControlError extends Error {
  readonly code: ControlErrorCode
  readonly retryAfterMs: number | undefined

  constructor(code: ControlErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ControlError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  get body(): ControlErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

/** The control code for a bridge command's failure: the same checks fail the same way through either. */
function codeOf(code: BridgeErrorCode): ControlErrorCode {
  switch (code) {
    case BridgeErrorCode.NotFound:
      return ControlErrorCode.NotFound
    // Busy: the agent is busy with something else, e.g. a compaction, so the task isn't in a state to take this now.
    case BridgeErrorCode.InvalidTransition:
    case BridgeErrorCode.Busy:
      return ControlErrorCode.InvalidTransition
    case BridgeErrorCode.InvalidRequest:
    case BridgeErrorCode.InvalidRootPath:
    case BridgeErrorCode.OutsideWorkspace:
      return ControlErrorCode.InvalidInput
    case BridgeErrorCode.UnknownCommand:
    case BridgeErrorCode.Internal:
      return ControlErrorCode.Internal
  }
}

/** Any error a call threw, as a control error: an unexpected one is `internal`. */
export function controlErrorFrom(error: unknown): ControlError {
  if (error instanceof ControlError) return error
  if (error instanceof CommandFailure) return new ControlError(codeOf(error.code), error.message)
  return new ControlError(ControlErrorCode.Internal, error instanceof Error ? error.message : String(error))
}

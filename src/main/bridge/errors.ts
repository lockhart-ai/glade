import type { BridgeErrorCode } from '../../shared/bridge'

/**
 * A command that failed for a reason the renderer can act on, such as a task that doesn't exist. The dispatcher answers
 * it with a `BridgeError` of the same code; anything else a handler throws becomes `internal`.
 */
export class CommandFailure extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'CommandFailure'
    this.code = code
  }
}

import type { BridgeErrorCode } from '../../shared/bridge'

/**
 * A failure a handler expects and can name, such as a request for something that doesn't exist. The dispatcher answers
 * it with its own `code` instead of `internal`, and doesn't log it.
 */
export class CommandError extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

/** What the error cards' toasts say when what a button asked of main couldn't start. */
import { describeFailure } from '../store/hydrate'

/** When a retry couldn't start. */
export function retryFailureMessage(error: unknown): string {
  return `Couldn’t retry: ${describeFailure(error)}`
}

/** When logging in couldn't start, or be cancelled. */
export function loginFailureMessage(error: unknown): string {
  return `Couldn’t log in: ${describeFailure(error)}`
}

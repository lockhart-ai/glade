/** A consumer waiting on an empty queue. */
interface Waiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: Error) => void
}

/**
 * An async iterable you push values into: a consumer's `for await` gets each value in order, waiting while the queue
 * is empty, until the queue is ended (the loop finishes) or failed (the loop throws). Iterate it once.
 *
 * The SDK adapter feeds a session's user messages to `query()` through one (streaming input mode), and the test backend
 * streams its scripted SDK messages through another.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private waiter: Waiter<T> | null = null
  private closed = false
  private failure: Error | null = null

  /** Adds a value. Does nothing once the queue has ended or failed. */
  push(value: T): void {
    if (this.closed) return
    const waiter = this.takeWaiter()
    if (waiter === null) this.values.push(value)
    else waiter.resolve({ value, done: false })
  }

  /** Ends the queue: the consumer gets the values already pushed, then its loop finishes. */
  end(): void {
    if (this.closed) return
    this.closed = true
    this.takeWaiter()?.resolve({ value: undefined, done: true })
  }

  /** Fails the queue: the consumer gets the values already pushed, then its loop throws `error`. */
  fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    this.takeWaiter()?.reject(error)
  }

  private takeWaiter(): Waiter<T> | null {
    const waiter = this.waiter
    this.waiter = null
    return waiter
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false })
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      // A consumer that stops early (`break`, or a throw in its loop) ends the queue.
      return: () => {
        this.end()
        this.values.length = 0
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

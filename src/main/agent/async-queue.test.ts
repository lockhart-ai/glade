import { expect, it } from 'vitest'
import { AsyncQueue } from './async-queue'

async function collect<T>(queue: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of queue) values.push(value)
  return values
}

it('gives values pushed before and while the consumer waits, in order, until ended', async () => {
  const queue = new AsyncQueue<number>()
  queue.push(1)
  const values = collect(queue)
  queue.push(2)
  await Promise.resolve()
  queue.push(3)
  queue.end()
  queue.push(4)

  await expect(values).resolves.toEqual([1, 2, 3])
})

it("finishes a waiting consumer's loop when ended, and ending twice is harmless", async () => {
  const queue = new AsyncQueue<number>()
  const values = collect(queue)
  queue.end()
  queue.end()

  await expect(values).resolves.toEqual([])
})

it('gives the values pushed before a failure, then throws it', async () => {
  const queue = new AsyncQueue<number>()
  const failure = new Error('crashed')
  queue.push(1)
  queue.fail(failure)
  queue.fail(new Error('again'))
  queue.push(2)
  const seen: number[] = []

  await expect(
    (async () => {
      for await (const value of queue) seen.push(value)
    })(),
  ).rejects.toBe(failure)
  expect(seen).toEqual([1])
})

it('throws a failure into a consumer that is waiting', async () => {
  const queue = new AsyncQueue<number>()
  const values = collect(queue)
  await Promise.resolve()
  queue.fail(new Error('crashed'))

  await expect(values).rejects.toThrow('crashed')
})

it('ends, dropping what is left, when the consumer stops early', async () => {
  const queue = new AsyncQueue<number>()
  queue.push(1)
  queue.push(2)
  for await (const value of queue) {
    expect(value).toBe(1)
    break
  }

  await expect(collect(queue)).resolves.toEqual([])
})

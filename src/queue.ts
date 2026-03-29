/**
 * Simple task queue with concurrency control.
 * Limits the number of concurrent agent executions.
 */

type TaskFn<T> = () => Promise<T>

interface QueuedTask<T> {
  fn: TaskFn<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export class TaskQueue {
  private queue: QueuedTask<unknown>[] = []
  private running = 0
  private readonly maxConcurrency: number

  constructor(maxConcurrency: number = 1) {
    this.maxConcurrency = maxConcurrency
  }

  async enqueue<T>(fn: TaskFn<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject } as QueuedTask<unknown>)
      this.processNext()
    })
  }

  get pending(): number {
    return this.queue.length
  }

  get active(): number {
    return this.running
  }

  private async processNext(): Promise<void> {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) {
      return
    }

    const task = this.queue.shift()!
    this.running++

    try {
      const result = await task.fn()
      task.resolve(result)
    } catch (error) {
      task.reject(error)
    } finally {
      this.running--
      this.processNext()
    }
  }
}

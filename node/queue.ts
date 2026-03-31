import { createLogger } from './logger.js'

type TaskFn<T> = () => Promise<T>

interface QueuedTask<T> {
  fn: TaskFn<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  enqueuedAt: number
}

const logger = createLogger('queue')

export class TaskQueue {
  private queue: QueuedTask<unknown>[] = []
  private running = 0
  private readonly maxConcurrency: number

  constructor(maxConcurrency: number = 1) {
    this.maxConcurrency = maxConcurrency
  }

  async enqueue<T>(fn: TaskFn<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, enqueuedAt: Date.now() } as QueuedTask<unknown>)
      logger.info('queue:enqueue', {
        pending: this.queue.length,
        active: this.running,
        maxConcurrency: this.maxConcurrency,
      })
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
    const startedAt = Date.now()
    logger.info('queue:start', {
      pending: this.queue.length,
      active: this.running,
      maxConcurrency: this.maxConcurrency,
      waitMs: startedAt - task.enqueuedAt,
    })

    try {
      const result = await task.fn()
      task.resolve(result)
    } catch (error) {
      task.reject(error)
    } finally {
      this.running--
      logger.info('queue:finish', {
        pending: this.queue.length,
        active: this.running,
        maxConcurrency: this.maxConcurrency,
        durationMs: Date.now() - startedAt,
      })
      this.processNext()
    }
  }
}

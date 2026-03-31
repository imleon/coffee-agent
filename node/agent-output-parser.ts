import { createLogger } from './logger.js'

const OUTPUT_START = '---OUTPUT_START---'
const OUTPUT_END = '---OUTPUT_END---'
const logger = createLogger('output-parser')

export type AgentEvent = Record<string, unknown>
export type EventCallback = (event: AgentEvent) => void

export function createOutputParser(onEvent: EventCallback) {
  let buffer = ''

  function feed(chunk: string): void {
    buffer += chunk

    while (true) {
      const startIdx = buffer.indexOf(OUTPUT_START)
      if (startIdx === -1) break

      const endIdx = buffer.indexOf(OUTPUT_END, startIdx)
      if (endIdx === -1) break

      const jsonStr = buffer.slice(startIdx + OUTPUT_START.length, endIdx).trim()
      buffer = buffer.slice(endIdx + OUTPUT_END.length)

      if (jsonStr) {
        try {
          const event = JSON.parse(jsonStr) as AgentEvent
          onEvent(event)
        } catch (e) {
          logger.error('parser:invalid-json', {
            error: e instanceof Error ? e.message : String(e),
            raw: jsonStr.slice(0, 200),
            length: jsonStr.length,
          })
        }
      }
    }

    if (buffer.length > 100_000 && !buffer.includes(OUTPUT_START.slice(0, 3))) {
      logger.warn('parser:buffer-reset', { length: buffer.length })
      buffer = ''
    }
  }

  function flush(): void {
    buffer = ''
  }

  return { feed, flush }
}

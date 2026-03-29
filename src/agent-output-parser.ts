/**
 * Parses Agent Runner stdout using the marker protocol:
 *   ---OUTPUT_START---
 *   { JSON payload }
 *   ---OUTPUT_END---
 */

const OUTPUT_START = '---OUTPUT_START---'
const OUTPUT_END = '---OUTPUT_END---'

export interface AgentEvent {
  type: string
  content: unknown
}

export type EventCallback = (event: AgentEvent) => void

/**
 * Creates a streaming parser for the marker-delimited protocol.
 * Call `feed(chunk)` as data arrives from stdout.
 */
export function createOutputParser(onEvent: EventCallback) {
  let buffer = ''

  function feed(chunk: string): void {
    buffer += chunk

    while (true) {
      const startIdx = buffer.indexOf(OUTPUT_START)
      if (startIdx === -1) break

      const endIdx = buffer.indexOf(OUTPUT_END, startIdx)
      if (endIdx === -1) break // incomplete, wait for more data

      const jsonStr = buffer.slice(
        startIdx + OUTPUT_START.length,
        endIdx
      ).trim()

      buffer = buffer.slice(endIdx + OUTPUT_END.length)

      if (jsonStr) {
        try {
          const event = JSON.parse(jsonStr) as AgentEvent
          onEvent(event)
        } catch (e) {
          console.error('[OutputParser] Failed to parse JSON:', e)
          console.error('[OutputParser] Raw:', jsonStr.slice(0, 200))
        }
      }
    }

    // Prevent buffer from growing unbounded with non-protocol output
    // Keep only the last chunk that might contain a partial marker
    if (buffer.length > 100_000 && !buffer.includes(OUTPUT_START.slice(0, 3))) {
      buffer = ''
    }
  }

  function flush(): void {
    buffer = ''
  }

  return { feed, flush }
}

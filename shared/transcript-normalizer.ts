import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface TranscriptBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'unknown'
  text?: string
  name?: string
  toolUseId?: string
  input?: unknown
  output?: unknown
  raw?: unknown
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
  blocks?: TranscriptBlock[]
  raw?: unknown
}

export type TranscriptRole = TranscriptMessage['role']

export function stringifyStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(stringifyStructuredValue).filter(Boolean).join('\n').trim()
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content

  if (Array.isArray(record.content)) {
    const nested = record.content.map(stringifyStructuredValue).filter(Boolean).join('\n').trim()
    if (nested) return nested
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function normalizeContentBlocks(message: unknown): TranscriptBlock[] {
  if (typeof message === 'string') {
    return [{ type: 'text', text: message, raw: message }]
  }

  if (Array.isArray(message)) {
    return message.flatMap((item) => normalizeContentBlocks(item))
  }

  if (!message || typeof message !== 'object') {
    return []
  }

  const record = message as Record<string, unknown>

  if (typeof record.content === 'string') {
    return [{ type: 'text', text: record.content, raw: message }]
  }

  if (Array.isArray(record.content)) {
    const blocks: TranscriptBlock[] = []

    for (const item of record.content) {
      if (!item || typeof item !== 'object') continue

      const block = item as Record<string, unknown>
      const type = typeof block.type === 'string' ? block.type : 'unknown'

      if (type === 'text') {
        blocks.push({
          type: 'text',
          text: typeof block.text === 'string' ? block.text : stringifyStructuredValue(block),
          raw: item,
        })
        continue
      }

      if (type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          name: typeof block.name === 'string' ? block.name : 'unknown_tool',
          toolUseId: typeof block.id === 'string'
            ? block.id
            : typeof block.toolUseId === 'string'
              ? block.toolUseId
              : undefined,
          input: block.input,
          raw: item,
        })
        continue
      }

      if (type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : typeof block.toolUseId === 'string'
              ? block.toolUseId
              : undefined,
          output: block.content ?? block.result ?? block.output,
          raw: item,
        })
        continue
      }

      if (type === 'thinking') {
        blocks.push({
          type: 'thinking',
          text: typeof block.thinking === 'string'
            ? block.thinking
            : typeof block.text === 'string'
              ? block.text
              : undefined,
          raw: item,
        })
        continue
      }

      blocks.push({
        type: 'unknown',
        raw: item,
      })
    }

    if (blocks.length > 0) return blocks
  }

  if (typeof record.text === 'string') {
    return [{ type: 'text', text: record.text, raw: message }]
  }

  return [{ type: 'unknown', raw: message }]
}

export function buildContentFromBlocks(blocks: TranscriptBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text || ''
        case 'tool_use':
          return `[Tool call] ${block.name || 'unknown_tool'}`
        case 'tool_result': {
          const output = stringifyStructuredValue(block.output)
          return output ? `[Tool result]\n${output}` : '[Tool result]'
        }
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function stringifyMessageContent(message: unknown, blocks: TranscriptBlock[]): string {
  const fromBlocks = buildContentFromBlocks(blocks)
  if (fromBlocks) return fromBlocks
  return stringifyStructuredValue(message)
}

export function extractTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined

  const record = message as Record<string, unknown>
  const candidate = record.timestamp ?? record.createdAt ?? record.created_at ?? record.time

  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  return undefined
}

export function normalizeTranscriptMessage(
  role: TranscriptRole,
  message: unknown,
  raw?: unknown,
  timestamp?: number
): TranscriptMessage {
  const blocks = normalizeContentBlocks(message)
  return {
    role,
    content: stringifyMessageContent(message, blocks),
    timestamp: timestamp ?? extractTimestamp(message),
    blocks,
    raw: raw ?? message,
  }
}

export function normalizeStoredTranscriptMessage(payload: unknown): TranscriptMessage {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const role = record.role === 'user' || record.role === 'assistant' || record.role === 'system'
    ? record.role
    : 'assistant'
  const message = 'raw' in record && record.raw !== undefined ? record.raw : payload
  const explicitContent = typeof record.content === 'string' ? record.content : undefined
  const normalized = normalizeTranscriptMessage(role, message, message, typeof record.timestamp === 'number' ? record.timestamp : undefined)

  return explicitContent && !normalized.content
    ? { ...normalized, content: explicitContent }
    : normalized
}

export function normalizeSdkEnvelopeMessage(payload: unknown): TranscriptMessage | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  if (record.type !== 'assistant' && record.type !== 'user') return null
  if (!('message' in record)) return null

  return normalizeTranscriptMessage(record.type, record.message, record, Date.now())
}

export function normalizeAssistantMessage(message: SDKAssistantMessage): TranscriptMessage {
  return normalizeTranscriptMessage('assistant', message.message, message)
}

export function normalizeUserMessage(message: SDKUserMessage): TranscriptMessage {
  return normalizeTranscriptMessage('user', message.message, message)
}

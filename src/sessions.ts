/**
 * Thin wrapper around Claude Agent SDK session APIs.
 * Provides session listing and message retrieval.
 */

// Note: These imports will be available once @anthropic-ai/claude-agent-sdk is installed.
// The SDK exports listSessions, getSessionMessages, getSessionInfo, forkSession.
// For now, we define the types and dynamic import.

import { CONFIG } from './config.js'
import type { SDKSessionInfo, SessionMessage as SDKSessionMessage } from '@anthropic-ai/claude-agent-sdk'

export interface SessionInfo {
  id: string
  title: string
  updatedAt: number
}

export interface SessionContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'unknown'
  text?: string
  name?: string
  toolUseId?: string
  input?: unknown
  output?: unknown
  raw?: unknown
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
  blocks?: SessionContentBlock[]
  raw?: unknown
}

function toSessionInfo(session: SDKSessionInfo): SessionInfo {
  return {
    id: session.sessionId,
    title: session.customTitle || session.summary || session.firstPrompt || session.sessionId,
    updatedAt: session.lastModified,
  }
}

function stringifyStructuredValue(value: unknown): string {
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
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeContentBlocks(message: unknown): SessionContentBlock[] {
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
    const blocks: SessionContentBlock[] = []

    for (const item of record.content) {
      if (!item || typeof item !== 'object') {
        continue
      }

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
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          input: block.input,
          raw: item,
        })
        continue
      }

      if (type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          output: block.content ?? block.result,
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

function stringifyMessageContent(message: unknown, blocks: SessionContentBlock[]): string {
  const fromBlocks = blocks.map((block) => {
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
  }).filter(Boolean).join('\n\n').trim()

  if (fromBlocks) return fromBlocks
  return stringifyStructuredValue(message)
}

function extractTimestamp(message: unknown): number | undefined {
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

function toSessionMessage(message: SDKSessionMessage): SessionMessage {
  const blocks = normalizeContentBlocks(message.message)

  return {
    role: message.type,
    content: stringifyMessageContent(message.message, blocks),
    timestamp: extractTimestamp(message.message),
    blocks,
    raw: message.message,
  }
}

/**
 * List all sessions in the workspace.
 */
export async function listAllSessions(): Promise<SessionInfo[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.listSessions === 'function') {
      const sessions = await sdk.listSessions({ dir: CONFIG.workspacePath })
      return sessions.map(toSessionInfo)
    }
    console.warn('[Sessions] listSessions not available in SDK, returning empty')
    return []
  } catch (e) {
    console.error('[Sessions] Failed to list sessions:', e)
    return []
  }
}

/**
 * Get messages for a specific session.
 */
export async function getMessages(
  sessionId: string,
  limit: number = 50
): Promise<SessionMessage[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.getSessionMessages === 'function') {
      const messages = await sdk.getSessionMessages(sessionId, {
        dir: CONFIG.workspacePath,
        limit,
      })
      return messages.map(toSessionMessage)
    }
    console.warn('[Sessions] getSessionMessages not available in SDK, returning empty')
    return []
  } catch (e) {
    console.error('[Sessions] Failed to get messages:', e)
    return []
  }
}

/**
 * Get info for a specific session.
 */
export async function getSession(sessionId: string): Promise<SessionInfo | null> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.getSessionInfo === 'function') {
      const info = await sdk.getSessionInfo(sessionId, {
        dir: CONFIG.workspacePath,
      })
      return info ? toSessionInfo(info) : null
    }
    return null
  } catch (e) {
    console.error('[Sessions] Failed to get session info:', e)
    return null
  }
}

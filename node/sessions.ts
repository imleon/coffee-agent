import { CONFIG } from './config.js'
import type { SDKSessionInfo, SessionMessage as SDKSessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionMessage, SessionSummary } from '../shared/message-types.js'
import {
  normalizeTranscriptMessage,
} from '../shared/transcript-normalizer.js'

export type SessionInfo = SessionSummary
export type StoredSessionMessage = SessionMessage

function toSessionInfo(session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: session.customTitle || session.summary || session.firstPrompt || session.sessionId,
    updatedAt: session.lastModified,
  }
}

function toSessionMessage(message: SDKSessionMessage): SessionMessage {
  return normalizeTranscriptMessage(message.type, message.message, message.message)
}

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

export async function getMessages(sessionId: string, limit: number = 50): Promise<SessionMessage[]> {
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

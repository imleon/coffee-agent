/**
 * Thin wrapper around Claude Agent SDK session APIs.
 * Provides session listing and message retrieval.
 */

// Note: These imports will be available once @anthropic-ai/claude-agent-sdk is installed.
// The SDK exports listSessions, getSessionMessages, getSessionInfo, forkSession.
// For now, we define the types and dynamic import.

import { CONFIG } from './config.js'

export interface SessionInfo {
  id: string
  createdAt?: string
  updatedAt?: string
  summary?: string
}

export interface SessionMessage {
  type: string
  content: unknown
  timestamp?: string
}

/**
 * List all sessions in the workspace.
 */
export async function listAllSessions(): Promise<SessionInfo[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.listSessions === 'function') {
      const sessions = await sdk.listSessions({ dir: CONFIG.workspacePath })
      return sessions as unknown as SessionInfo[]
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
      return messages as unknown as SessionMessage[]
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
      return info as unknown as SessionInfo
    }
    return null
  } catch (e) {
    console.error('[Sessions] Failed to get session info:', e)
    return null
  }
}

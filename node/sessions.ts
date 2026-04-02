import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG } from './config.js'
import type { SDKSessionInfo, SessionMessage as SDKSessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionMessage, SessionSummary } from '../shared/message-types.js'
import {
  extractTimestamp,
  normalizeTranscriptMessage,
} from '../shared/transcript-normalizer.js'

export type SessionInfo = SessionSummary
export type StoredSessionMessage = SessionMessage

type TranscriptMessageRecord = {
  uuid?: string
  parentUuid?: string | null
  [key: string]: unknown
}

async function findClaudeSessionFile(sessionId: string): Promise<string | null> {
  const projectsDir = resolve(homedir(), '.claude/projects')
  let entries: string[] = []
  try {
    entries = await readdir(projectsDir)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
    if (code === 'ENOENT') return null
    throw error
  }

  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`)
    try {
      await readFile(candidate, 'utf-8')
      return candidate
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
      if (code === 'ENOENT') continue
      throw error
    }
  }

  return null
}

async function readTranscriptParentMap(sessionId: string): Promise<Map<string, string | null>> {
  const filePath = await findClaudeSessionFile(sessionId)
  if (!filePath) return new Map()

  const content = await readFile(filePath, 'utf-8')
  const parentByUuid = new Map<string, string | null>()

  for (const line of content.split('\n')) {
    if (!line.trim()) continue

    try {
      const record = JSON.parse(line) as TranscriptMessageRecord
      if (typeof record.uuid !== 'string' || !record.uuid) continue
      if (typeof record.parentUuid === 'string') {
        parentByUuid.set(record.uuid, record.parentUuid)
        continue
      }
      if (record.parentUuid === null) {
        parentByUuid.set(record.uuid, null)
      }
    } catch {
      continue
    }
  }

  return parentByUuid
}

function toSessionInfo(session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: session.customTitle || session.summary || session.firstPrompt || session.sessionId,
    updatedAt: session.lastModified,
  }
}

function toSessionMessage(message: SDKSessionMessage, parentUuid?: string | null): SessionMessage {
  const raw = message && typeof message === 'object'
    ? {
      ...message,
      ...(parentUuid !== undefined ? { parentUuid } : {}),
    }
    : message

  return normalizeTranscriptMessage(
    message.type,
    message.message,
    raw,
    extractTimestamp(message) ?? extractTimestamp(message.message),
  )
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
      const [messages, parentByUuid] = await Promise.all([
        sdk.getSessionMessages(sessionId, {
          dir: CONFIG.workspacePath,
          limit,
        }),
        readTranscriptParentMap(sessionId),
      ])
      return messages.map((message) => toSessionMessage(message, parentByUuid.get(message.uuid)))
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

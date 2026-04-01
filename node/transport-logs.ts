import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionTransportLogEntry, SessionTransportLogPage, SdkTransportEvent } from '../shared/message-types.js'
import { sanitizeValue } from './logger.js'

const TRANSPORT_LOG_DIR = './data/transport-logs'
const DEFAULT_TRANSPORT_PAGE_SIZE = 100
const MAX_TRANSPORT_PAGE_SIZE = 200

type StoredTransportLogRecord = {
  runId: string
  event: SdkTransportEvent & { sessionId: string }
}

function getTransportLogFilePath(sessionId: string): string {
  return join(TRANSPORT_LOG_DIR, `${sessionId}.ndjson`)
}

function sanitizeSessionId(sessionId: string): string | null {
  return /^[a-zA-Z0-9._-]+$/.test(sessionId) ? sessionId : null
}

function normalizeTransportPayload(event: SdkTransportEvent): SdkTransportEvent {
  if (event.payload === undefined) return event
  return {
    ...event,
    payload: sanitizeValue(event.payload),
  }
}

export async function appendSessionTransportLog(runId: string, event: SdkTransportEvent): Promise<void> {
  const sessionId = typeof event.sessionId === 'string' ? sanitizeSessionId(event.sessionId) : null
  if (!sessionId) return

  const filePath = getTransportLogFilePath(sessionId)
  await mkdir(dirname(filePath), { recursive: true })
  const record: StoredTransportLogRecord = {
    runId,
    event: {
      ...normalizeTransportPayload(event),
      sessionId,
    },
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8')
}

function parseTransportLogLine(line: string, cursor: number): SessionTransportLogEntry | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as Partial<StoredTransportLogRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.runId !== 'string') return null
    if (!parsed.event || typeof parsed.event !== 'object') return null
    const event = parsed.event as SdkTransportEvent & { sessionId?: string }
    if (typeof event.sessionId !== 'string' || !sanitizeSessionId(event.sessionId)) return null
    if (event.source !== 'sdk-transport') return null
    return {
      cursor,
      runId: parsed.runId,
      event: {
        ...event,
        sessionId: event.sessionId,
      },
    }
  } catch {
    return null
  }
}

export async function readSessionTransportLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_TRANSPORT_PAGE_SIZE,
  follow: boolean = false,
): Promise<SessionTransportLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TRANSPORT_PAGE_SIZE, Math.floor(limit))) : DEFAULT_TRANSPORT_PAGE_SIZE
  const filePath = getTransportLogFilePath(safeSessionId)

  let content = ''
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
    if (code === 'ENOENT') {
      return { items: [], hasMore: false, nextCursor: null }
    }
    throw error
  }

  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const total = lines.length
  const boundedCursor = typeof cursor === 'number' && Number.isFinite(cursor)
    ? Math.max(0, Math.min(total, Math.floor(cursor)))
    : null
  const endExclusive = follow
    ? total
    : boundedCursor ?? total
  const start = follow
    ? (boundedCursor ?? total)
    : Math.max(0, endExclusive - safeLimit)
  const items: SessionTransportLogEntry[] = []

  for (let index = start; index < endExclusive; index += 1) {
    const entry = parseTransportLogLine(lines[index] || '', index + 1)
    if (entry) items.push(entry)
  }

  return {
    items,
    hasMore: follow ? false : start > 0,
    nextCursor: items.length > 0 ? items[items.length - 1]!.cursor : boundedCursor ?? total,
  }
}

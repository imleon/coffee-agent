import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  PendingInteraction,
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionSummary,
  SessionTransportLogEntry,
  SdkMessageLayer,
} from '../../../shared/message-types.js'
import {
  getSdkMessageLayer,
  isBusinessSdkMessage,
  isRunStateSdkMessage,
} from '../../../shared/message-types.js'
import {
  normalizeSdkEnvelopeMessage,
  normalizeStoredTranscriptMessage,
} from '../../../shared/transcript-normalizer.js'
import { createDebugLogger } from '../lib/debug.js'

export type {
  PendingInteraction,
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionSummary,
}

export interface SdkTimelineItem {
  kind: 'sdk-message'
  key: string
  event: Extract<SessionEvent, { type: 'session.sdk.message' }>
  timestamp: number
}

export interface RunStateSdkEventItem {
  kind: 'run-state-event'
  key: string
  event: Extract<SessionEvent, { type: 'session.sdk.message' }>
  layer: SdkMessageLayer
  timestamp: number
}

export interface HistoryUserMessageTimelineItem {
  kind: 'history-user-message'
  key: string
  message: HistoryMessage
  timestamp: number
}

export interface HistorySingleMessageTimelineItem {
  kind: 'history-message'
  key: string
  message: HistoryMessage
  timestamp: number
}

export interface HistoryAssistantThreadItem {
  key: string
  message: HistoryMessage
  depth: number
  timestamp: number
}

export interface HistoryAssistantThreadTimelineItem {
  kind: 'history-assistant-thread'
  key: string
  rootMessage: HistoryMessage
  items: HistoryAssistantThreadItem[]
  timestamp: number
  executionDurationMs: number | null
}

export type HistoryTimelineItem = HistoryUserMessageTimelineItem | HistorySingleMessageTimelineItem | HistoryAssistantThreadTimelineItem

export type TimelineItem = SdkTimelineItem | HistoryTimelineItem

interface HealthResponse {
  status?: string
  authEnabled?: boolean
}

interface TransportLogsResponse {
  items?: SessionTransportLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

const AUTH_TOKEN_STORAGE_KEY = 'cotta-auth-token'
const logger = createDebugLogger('session-store')
const EVENT_LOG_INTERVAL = 20
const OPTIMISTIC_USER_MATCH_WINDOW_MS = 30_000

type HistoryMessage = SessionMessage & {
  optimistic?: boolean
  localId?: string
}

function getHistoryMessageUuid(message: HistoryMessage): string | null {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return null
  return typeof (raw as Record<string, unknown>).uuid === 'string' ? (raw as Record<string, unknown>).uuid as string : null
}

function getHistoryMessageParentUuid(message: HistoryMessage): string | null {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return null
  return typeof (raw as Record<string, unknown>).parentUuid === 'string' ? (raw as Record<string, unknown>).parentUuid as string : null
}

function getHistoryMessageTimestamp(message: HistoryMessage, fallback: number): number {
  return typeof message.timestamp === 'number' ? message.timestamp : fallback
}

function isAssistantHistoryMessage(message: HistoryMessage): boolean {
  return message.role === 'assistant'
}

function getHistoryMessageKey(message: HistoryMessage, index: number): string {
  return getHistoryMessageUuid(message) ?? `history-${index}`
}

function isAssistantThreadRoot(message: HistoryMessage, messagesByUuid: Map<string, HistoryMessage>): boolean {
  if (!isAssistantHistoryMessage(message)) return false
  const parentUuid = getHistoryMessageParentUuid(message)
  if (!parentUuid) return true
  const parent = messagesByUuid.get(parentUuid)
  return !parent || parent.role !== 'assistant'
}

function getAssistantThreadExecutionDuration(
  rootMessage: HistoryMessage,
  lastTimestamp: number,
  messagesByUuid: Map<string, HistoryMessage>,
  fallbackIndex: number,
): number | null {
  const parentUuid = getHistoryMessageParentUuid(rootMessage)
  if (!parentUuid) return null

  const parentMessage = messagesByUuid.get(parentUuid)
  if (!parentMessage || parentMessage.role !== 'user') return null

  const parentTimestamp = getHistoryMessageTimestamp(parentMessage, fallbackIndex)
  const duration = lastTimestamp - parentTimestamp
  return duration >= 0 ? duration : null
}

function buildHistoryTimeline(messages: HistoryMessage[]): HistoryTimelineItem[] {
  const messagesByUuid = new Map<string, HistoryMessage>()
  const messageIndexByUuid = new Map<string, number>()
  const childrenByParent = new Map<string, HistoryMessage[]>()

  for (const [index, message] of messages.entries()) {
    const uuid = getHistoryMessageUuid(message)
    if (!uuid) continue
    messagesByUuid.set(uuid, message)
    messageIndexByUuid.set(uuid, index)
  }

  for (const message of messages) {
    const parentUuid = getHistoryMessageParentUuid(message)
    if (!parentUuid) continue
    const parent = messagesByUuid.get(parentUuid)
    if (!parent) continue
    const siblings = childrenByParent.get(parentUuid) ?? []
    siblings.push(message)
    childrenByParent.set(parentUuid, siblings)
  }

  const assistantItemsByRootUuid = new Map<string, HistoryAssistantThreadItem[]>()
  const assistantCoveredUuids = new Set<string>()

  const appendAssistantThreadItems = (message: HistoryMessage, depth: number, bucket: HistoryAssistantThreadItem[]) => {
    const uuid = getHistoryMessageUuid(message)
    const fallbackIndex = typeof uuid === 'string' ? (messageIndexByUuid.get(uuid) ?? bucket.length) : bucket.length
    if (isAssistantHistoryMessage(message)) {
      if (uuid) assistantCoveredUuids.add(uuid)
      bucket.push({
        key: `${getHistoryMessageKey(message, fallbackIndex)}-${depth}`,
        message,
        depth,
        timestamp: getHistoryMessageTimestamp(message, fallbackIndex),
      })
    }

    if (!uuid) return
    const children = childrenByParent.get(uuid) ?? []
    for (const child of children) {
      if (!isAssistantHistoryMessage(child)) continue
      appendAssistantThreadItems(child, depth + 1, bucket)
    }
  }

  for (const message of messages) {
    if (!isAssistantThreadRoot(message, messagesByUuid)) continue
    const rootUuid = getHistoryMessageUuid(message)
    const fallbackIndex = typeof rootUuid === 'string' ? (messageIndexByUuid.get(rootUuid) ?? 0) : 0
    const items: HistoryAssistantThreadItem[] = []
    appendAssistantThreadItems(message, 0, items)
    if (!items.length) continue
    assistantItemsByRootUuid.set(getHistoryMessageKey(message, fallbackIndex), items)
  }

  const timeline: HistoryTimelineItem[] = []

  for (const [index, message] of messages.entries()) {
    const timestamp = getHistoryMessageTimestamp(message, index)
    const key = getHistoryMessageKey(message, index)

    if (message.role === 'user') {
      timeline.push({
        kind: 'history-user-message',
        key: `history-user-${key}`,
        message,
        timestamp,
      })
      continue
    }

    if (isAssistantThreadRoot(message, messagesByUuid)) {
      const items = assistantItemsByRootUuid.get(key) ?? []
      if (!items.length) continue
      const lastTimestamp = items[items.length - 1]?.timestamp ?? timestamp
      timeline.push({
        kind: 'history-assistant-thread',
        key: `history-assistant-thread-${key}`,
        rootMessage: message,
        items,
        timestamp: lastTimestamp,
        executionDurationMs: getAssistantThreadExecutionDuration(message, lastTimestamp, messagesByUuid, index),
      })
      continue
    }

    if (isAssistantHistoryMessage(message)) {
      const uuid = getHistoryMessageUuid(message)
      if (uuid && assistantCoveredUuids.has(uuid)) continue
    }

    timeline.push({
      kind: 'history-message',
      key: `history-${key}`,
      message,
      timestamp,
    })
  }

  return timeline
}

function normalizeSession(item: any): SessionSummary {
  return {
    id: typeof item?.id === 'string' ? item.id : '',
    title: typeof item?.title === 'string' && item.title ? item.title : (typeof item?.id === 'string' ? item.id.slice(0, 8) : 'Untitled'),
    updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : Date.now(),
  }
}

function getEventRunId(event: SessionEvent): string | null {
  return 'runId' in event && typeof event.runId === 'string' ? event.runId : null
}

function isRunScopedEvent(event: SessionEvent): boolean {
  return event.type !== 'session.error' || typeof event.runId === 'string'
}

function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString())
  if (safe.searchParams.has('auth')) {
    safe.searchParams.set('auth', '[REDACTED]')
  }
  return safe.toString()
}

function getTimelineMessageFromEvent(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): SessionMessage | null {
  return event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
}

function isMatchingOptimisticUserMessage(message: HistoryMessage, candidate: SessionMessage, timestamp: number): boolean {
  if (!message.optimistic || message.role !== 'user' || candidate.role !== 'user') return false
  if (message.content.trim() !== candidate.content.trim()) return false
  const messageTimestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
  return Math.abs(messageTimestamp - timestamp) <= OPTIMISTIC_USER_MATCH_WINDOW_MS
}

export const useSessionStore = defineStore('session', () => {
  const historyMessages = ref<HistoryMessage[]>([])
  const sessions = ref<SessionSummary[]>([])
  const currentSessionId = ref<string | null>(null)
  const isConnected = ref(false)
  const runState = ref<SessionRunState>('idle')
  const authToken = ref(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '')
  const authError = ref('')
  const authRequired = ref(false)
  const authChecked = ref(false)
  const activeRunId = ref<string | null>(null)
  const pendingInteraction = ref<PendingInteraction | null>(null)
  const eventLog = ref<Array<Extract<SessionEvent, { type: 'session.sdk.message' }>>>([])

  const isLoading = computed(() => ['queued', 'running', 'requires_action'].includes(runState.value))
  const hasAuthToken = computed(() => authToken.value.trim().length > 0)
  const isAwaitingApproval = computed(() => pendingInteraction.value?.kind === 'permission' && pendingInteraction.value?.status === 'pending')
  const isAwaitingInteraction = computed(() => pendingInteraction.value?.status === 'pending')
  const hasActiveRun = computed(() => awaitingRunStart || activeRunId.value !== null)
  const sdkEvents = computed(() => eventLog.value)
  const telemetry = computed(() => eventLog.value.filter((event) => !isBusinessSdkMessage(event.payload)))
  const observabilityEvents = computed(() => eventLog.value.filter((event) => {
    if (getSdkMessageLayer(event.payload) !== 'debug-observability') return false
    return !(event.payload?.type === 'system' && event.payload?.subtype === 'init')
  }))
  const runStateEvents = computed<RunStateSdkEventItem[]>(() =>
    eventLog.value
      .filter((event) => isRunStateSdkMessage(event.payload))
      .map((event, index) => ({
        kind: 'run-state-event',
        key: `run-state-${event.sequence}-${index}`,
        event,
        layer: getSdkMessageLayer(event.payload),
        timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : Date.now(),
      }))
  )
  const liveSdkTimeline = computed<SdkTimelineItem[]>(() =>
    eventLog.value
      .filter((event) => isBusinessSdkMessage(event.payload))
      .map((event, index) => ({
        kind: 'sdk-message',
        key: `${event.sequence}-${index}`,
        event,
        timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : Date.now(),
      }))
  )
  const historyTimeline = computed<HistoryTimelineItem[]>(() =>
    buildHistoryTimeline(historyMessages.value)
  )
  const timeline = computed<TimelineItem[]>(() => {
    const items = [...historyTimeline.value, ...liveSdkTimeline.value]
    return items.sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp

      if (left.kind === 'sdk-message' && right.kind === 'sdk-message') {
        return left.event.sequence - right.event.sequence
      }

      if (left.kind !== 'sdk-message' && right.kind !== 'sdk-message') {
        return left.timestamp - right.timestamp || left.key.localeCompare(right.key)
      }

      const leftRole = left.kind === 'sdk-message'
        ? getTimelineMessageFromEvent(left.event)?.role
        : left.kind === 'history-message'
          ? left.message.role
          : 'assistant'
      const rightRole = right.kind === 'sdk-message'
        ? getTimelineMessageFromEvent(right.event)?.role
        : right.kind === 'history-message'
          ? right.message.role
          : 'assistant'

      if (leftRole === rightRole) {
        return left.kind === 'sdk-message' ? 1 : -1
      }

      if (leftRole === 'user') return -1
      if (rightRole === 'user') return 1
      return left.kind === 'history-message' ? -1 : 1
    })
  })

  let ws: WebSocket | null = null
  let awaitingRunStart = false
  let observedEventCount = 0
  let optimisticMessageCount = 0

  function persistAuthToken(token: string) {
    authToken.value = token.trim()
    logger.info('auth:set-token', {
      hasToken: Boolean(authToken.value),
      tokenLength: authToken.value.length,
    })
    if (authToken.value) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken.value)
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    }
  }

  function clearRunState(nextState: SessionRunState = 'idle') {
    logger.debug('chat:run-state:clear', {
      nextState,
      activeRunId: shortId(activeRunId.value),
      currentState: runState.value,
    })
    activeRunId.value = null
    awaitingRunStart = false
    pendingInteraction.value = null
    runState.value = nextState
  }

  function clearConnection() {
    if (ws) {
      logger.info('ws:clear-connection', {
        readyState: ws.readyState,
      })
      ws.onclose = null
      ws.close()
      ws = null
    }
    isConnected.value = false
  }

  function syncSessionId(sessionId?: string) {
    if (typeof sessionId === 'string' && sessionId) {
      if (currentSessionId.value !== sessionId) {
        logger.info('chat:session-sync', {
          from: shortId(currentSessionId.value),
          to: shortId(sessionId),
        })
      }
      currentSessionId.value = sessionId
    }
  }

  function claimRun(event: SessionEvent): boolean {
    if (!isRunScopedEvent(event)) return true

    const eventRunId = getEventRunId(event)
    if (!eventRunId) {
      return activeRunId.value === null
    }

    if (activeRunId.value) {
      return activeRunId.value === eventRunId
    }

    if (awaitingRunStart) {
      activeRunId.value = eventRunId
      awaitingRunStart = false
      logger.info('chat:run-claimed', {
        runId: shortId(eventRunId),
      })
      return true
    }

    logger.warn('chat:event:ignored-unclaimed-run', {
      type: event.type,
      runId: shortId(eventRunId),
    })
    return false
  }

  function applySdkMessage(event: Extract<SessionEvent, { type: 'session.sdk.message' }>) {
    const parsedMessage = getTimelineMessageFromEvent(event)
    const eventTimestamp = typeof event.receivedAt === 'number' ? event.receivedAt : Date.now()

    if (parsedMessage?.role === 'user') {
      let removedOptimistic = false
      historyMessages.value = historyMessages.value.filter((message) => {
        if (removedOptimistic) return true
        if (!isMatchingOptimisticUserMessage(message, parsedMessage, eventTimestamp)) return true
        removedOptimistic = true
        return false
      })
    }

    eventLog.value = [...eventLog.value.slice(-199), event]
    syncSessionId(event.sessionId)
    if (eventLog.value.length === 1 || eventLog.value.length % EVENT_LOG_INTERVAL === 0) {
      logger.debug('chat:sdk-message', {
        count: eventLog.value.length,
        payloadType: event.payload?.type,
        sequence: event.sequence,
        sessionId: shortId(event.sessionId),
      })
    }
  }

  function applyTransportEvent(event: Extract<SessionEvent, { type: 'session.sdk.transport' }>) {
    syncSessionId(event.event.sessionId)
    logger.debug('chat:sdk-transport:ignored-ws', {
      direction: event.event.direction,
      eventName: event.event.eventName,
      sequence: event.event.sequence,
      sessionId: shortId(event.event.sessionId),
    })
  }

  function applyEvent(event: SessionEvent) {
    observedEventCount += 1
    if (observedEventCount === 1 || observedEventCount % EVENT_LOG_INTERVAL === 0 || (event.type !== 'session.sdk.message' && event.type !== 'session.sdk.transport')) {
      logger.info('session:event', {
        count: observedEventCount,
        type: event.type,
        runId: 'runId' in event ? shortId(event.runId) : undefined,
        sessionId: 'sessionId' in event ? shortId(event.sessionId) : event.type === 'session.sdk.transport' ? shortId(event.event.sessionId) : undefined,
        state: 'state' in event ? event.state : undefined,
        sequence: 'sequence' in event ? event.sequence : event.type === 'session.sdk.transport' ? event.event.sequence : undefined,
      })
    }

    if (!claimRun(event)) return

    switch (event.type) {
      case 'session.run.queued':
        runState.value = 'queued'
        syncSessionId(event.sessionId)
        break

      case 'session.run.started':
        runState.value = 'running'
        syncSessionId(event.sessionId)
        break

      case 'session.run.state_changed':
        runState.value = event.state
        syncSessionId(event.sessionId)
        if (event.state === 'cancelled') {
          clearRunState('cancelled')
        } else if (event.state !== 'requires_action' && pendingInteraction.value?.status === 'pending') {
          pendingInteraction.value = null
        }
        break

      case 'session.run.completed':
        pendingInteraction.value = null
        runState.value = 'completed'
        activeRunId.value = null
        awaitingRunStart = false
        syncSessionId(event.sessionId)
        logger.info('chat:done', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          exitCode: event.exitCode,
          hasError: Boolean(event.error),
        })
        fetchSessions()
        if (event.sessionId && currentSessionId.value === event.sessionId) {
          loadSessionMessages(event.sessionId)
        }
        break

      case 'session.run.failed':
        historyMessages.value.push({
          role: 'system',
          content: `Error: ${event.error}`,
          timestamp: Date.now(),
        })
        logger.error('chat:error', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          error: event.error,
        })
        clearRunState('failed')
        syncSessionId(event.sessionId)
        break

      case 'session.run.cancelled':
        logger.warn('chat:cancelled', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
        })
        clearRunState('cancelled')
        syncSessionId(event.sessionId)
        break

      case 'session.sdk.message':
        applySdkMessage(event)
        break

      case 'session.sdk.transport':
        applyTransportEvent(event)
        break

      case 'session.sdk.control.requested':
        pendingInteraction.value = event.interaction
        runState.value = 'requires_action'
        logger.info('chat:interaction:requested', {
          kind: event.interaction.kind,
          interactionId: shortId(event.interaction.id),
          sessionId: shortId(event.sessionId),
        })
        syncSessionId(event.sessionId)
        break

      case 'session.sdk.control.resolved':
        if (pendingInteraction.value?.id === event.interaction.id) {
          pendingInteraction.value = null
        }
        logger.info('chat:interaction:resolved', {
          kind: event.interaction.kind,
          interactionId: shortId(event.interaction.id),
          sessionId: shortId(event.sessionId),
        })
        syncSessionId(event.sessionId)
        break

      case 'session.error':
        historyMessages.value.push({
          role: 'system',
          content: `Error: ${event.error}`,
          timestamp: Date.now(),
        })
        logger.error('chat:error', {
          runId: shortId(event.runId),
          error: event.error,
        })
        break
    }
  }

  async function checkHealth() {
    logger.info('health:request')
    try {
      const res = await fetch('/api/health')
      const data = await res.json() as HealthResponse
      authRequired.value = Boolean(data.authEnabled)
      logger.info('health:success', {
        status: data.status,
        authEnabled: authRequired.value,
      })
    } catch (error) {
      authRequired.value = false
      logger.warn('health:error', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      authChecked.value = true
    }
  }

  async function apiFetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || undefined)
    if (hasAuthToken.value) {
      headers.set('Authorization', `Bearer ${authToken.value}`)
    }

    logger.debug('http:request', {
      input,
      method: init.method || 'GET',
      hasAuthToken: hasAuthToken.value,
    })
    const res = await fetch(input, {
      ...init,
      headers,
    })

    if (res.status === 401) {
      authError.value = '认证失败，请重新输入访问令牌。'
      isConnected.value = false
      logger.warn('auth:401', {
        input,
        method: init.method || 'GET',
      })
    }

    return res
  }

  function connect() {
    if (authRequired.value && !hasAuthToken.value) {
      authError.value = '请输入访问令牌。'
      logger.warn('ws:connect:blocked', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
      return
    }

    clearConnection()
    authError.value = ''

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = new URL(`${protocol}//${location.host}/ws`)
    if (hasAuthToken.value) {
      wsUrl.searchParams.set('auth', authToken.value)
    }

    logger.info('ws:connect:start', {
      url: redactUrl(wsUrl),
      hasAuthToken: hasAuthToken.value,
      authRequired: authRequired.value,
    })
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      isConnected.value = true
      authError.value = ''
      logger.info('ws:open')
    }

    ws.onclose = (event) => {
      isConnected.value = false
      ws = null
      logger.warn('ws:close', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (!authError.value && (!authRequired.value || hasAuthToken.value)) {
        logger.info('ws:reconnect:scheduled', { delayMs: 3000 })
        setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => {
      isConnected.value = false
      logger.warn('ws:error', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
      if (authRequired.value && hasAuthToken.value) {
        authError.value = '连接失败，请检查访问令牌是否正确。'
      }
    }

    ws.onmessage = (evt) => {
      try {
        applyEvent(JSON.parse(evt.data) as SessionEvent)
      } catch (error) {
        logger.warn('ws:message:parse-error', {
          error: error instanceof Error ? error.message : String(error),
          raw: typeof evt.data === 'string' ? evt.data.slice(0, 160) : typeof evt.data,
        })
      }
    }
  }

  function sendMessage(prompt: string) {
    const trimmed = prompt.trim()
    if (!ws || ws.readyState !== WebSocket.OPEN || !trimmed || isAwaitingInteraction.value || hasActiveRun.value) {
      logger.warn('chat:send:blocked', {
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        hasPrompt: Boolean(trimmed),
        awaitingInteraction: isAwaitingInteraction.value,
        hasActiveRun: hasActiveRun.value,
      })
      return
    }

    awaitingRunStart = true
    activeRunId.value = null
    pendingInteraction.value = null
    runState.value = 'queued'
    optimisticMessageCount += 1
    historyMessages.value = [
      ...historyMessages.value,
      {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        optimistic: true,
        localId: `optimistic-${optimisticMessageCount}`,
      },
    ]
    logger.info('chat:send', {
      promptLength: trimmed.length,
      sessionId: shortId(currentSessionId.value),
      hasActiveRun: hasActiveRun.value,
    })

    ws.send(
      JSON.stringify({
        action: 'message.create',
        prompt: trimmed,
        ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
      })
    )
  }

  async function fetchSessions(): Promise<boolean> {
    logger.info('sessions:fetch:start')
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) {
        logger.warn('sessions:fetch:error', { status: res.status })
        return false
      }
      const data = await res.json()
      sessions.value = (data.sessions || []).map((s: any) => normalizeSession(s)).filter((s: SessionSummary) => s.id)
      logger.info('sessions:fetch:success', {
        count: sessions.value.length,
      })
      return true
    } catch (error) {
      logger.error('sessions:fetch:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function newChat() {
    logger.info('chat:new')
    currentSessionId.value = null
    historyMessages.value = []
    eventLog.value = []
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
  }

  function selectSession(id: string) {
    logger.info('chat:select-session', {
      sessionId: shortId(id),
    })
    currentSessionId.value = id
    historyMessages.value = []
    eventLog.value = []
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
    loadSessionMessages(id)
  }

  async function loadSessionMessages(id: string) {
    logger.info('messages:load:start', {
      sessionId: shortId(id),
    })
    try {
      const res = await apiFetch(`/api/sessions/${id}/messages`)
      if (!res.ok) {
        logger.warn('messages:load:error', {
          sessionId: shortId(id),
          status: res.status,
        })
        return
      }
      const data = await res.json()
      historyMessages.value = (data.messages || []).map((m: unknown) => normalizeStoredTranscriptMessage(m))
      eventLog.value = eventLog.value.filter((event) => {
        if (!event.sessionId || event.sessionId !== id) return true
        return !isBusinessSdkMessage(event.payload)
      })
      logger.info('messages:load:success', {
        sessionId: shortId(id),
        count: historyMessages.value.length,
      })
    } catch (error) {
      logger.error('messages:load:error', {
        sessionId: shortId(id),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function respondToPermission(decision: 'approve' | 'deny') {
    if (!ws || ws.readyState !== WebSocket.OPEN || !pendingInteraction.value || pendingInteraction.value.kind !== 'permission' || !activeRunId.value) {
      logger.warn('chat:permission:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        interactionKind: pendingInteraction.value?.kind,
        activeRunId: shortId(activeRunId.value),
      })
      return
    }

    logger.info('chat:permission:respond', {
      decision,
      interactionId: shortId(pendingInteraction.value.id),
      runId: shortId(activeRunId.value),
    })
    ws.send(
      JSON.stringify({
        action: 'permission.respond',
        runId: activeRunId.value,
        permissionId: pendingInteraction.value.id,
        decision,
      })
    )
  }

  function respondToElicitation(response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !pendingInteraction.value || pendingInteraction.value.kind !== 'elicitation' || !activeRunId.value) {
      logger.warn('chat:elicitation:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        interactionKind: pendingInteraction.value?.kind,
        activeRunId: shortId(activeRunId.value),
      })
      return
    }

    logger.info('chat:elicitation:respond', {
      action: response.action,
      interactionId: shortId(pendingInteraction.value.id),
      runId: shortId(activeRunId.value),
    })
    ws.send(
      JSON.stringify({
        action: 'elicitation.respond',
        runId: activeRunId.value,
        requestId: pendingInteraction.value.id,
        responseAction: response.action,
        ...(response.content ? { content: response.content } : {}),
      })
    )
  }

  async function initialize() {
    logger.info('initialize:start', {
      hasAuthToken: hasAuthToken.value,
    })
    await checkHealth()
    if (!authRequired.value) {
      connect()
      await fetchSessions()
      return
    }

    if (hasAuthToken.value) {
      const ok = await fetchSessions()
      if (ok) {
        connect()
      }
    }
  }

  async function setAuthToken(token: string) {
    persistAuthToken(token)
    authError.value = ''
    if (!authChecked.value) return

    if (!authRequired.value) {
      connect()
      await fetchSessions()
      return
    }

    const ok = await fetchSessions()
    if (ok) {
      connect()
    }
  }

  function clearAuthToken() {
    logger.info('auth:clear-token')
    persistAuthToken('')
    clearConnection()
    authError.value = ''
    currentSessionId.value = null
    historyMessages.value = []
    sessions.value = []
    eventLog.value = []
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
  }

  return {
    timeline,
    historyMessages,
    sessions,
    currentSessionId,
    isConnected,
    isLoading,
    runState,
    authToken,
    authError,
    authRequired,
    authChecked,
    hasAuthToken,
    hasActiveRun,
    activeRunId,
    pendingInteraction,
    sdkEvents,
    telemetry,
    observabilityEvents,
    runStateEvents,
    eventLog,
    isAwaitingApproval,
    isAwaitingInteraction,
    connect,
    sendMessage,
    respondToPermission,
    respondToElicitation,
    fetchSessions,
    newChat,
    selectSession,
    initialize,
    setAuthToken,
    clearAuthToken,
  }
})

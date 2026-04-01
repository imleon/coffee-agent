import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { SessionSummary, SessionTransportLogEntry } from '../../../shared/message-types.js'
import { createDebugLogger } from '../lib/debug.js'
import { useSessionStore } from './session'

interface TransportLogsResponse {
  items?: SessionTransportLogEntry[]
  hasMore?: boolean
  nextCursor?: number | null
}

const logger = createDebugLogger('log-view-store')
const SESSION_LIST_REFRESH_INTERVAL_MS = 3000

function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

export const useLogViewStore = defineStore('log-view', () => {
  const sessionStore = useSessionStore()
  const selectedSessionId = ref<string | null>(null)
  const transportLog = ref<SessionTransportLogEntry[]>([])
  const transportLogHasMore = ref(false)
  const transportLogCursor = ref<number | null>(null)
  const transportLogLoading = ref(false)
  const transportLogRefreshing = ref(false)
  const transportLogFollowing = ref(false)
  const transportLogLive = ref(true)
  let transportFollowTimer: number | null = null
  let sessionListRefreshTimer: number | null = null

  const sessions = computed<SessionSummary[]>(() => sessionStore.sessions)

  function stopTransportFollow() {
    if (transportFollowTimer !== null) {
      window.clearTimeout(transportFollowTimer)
      transportFollowTimer = null
    }
    transportLogFollowing.value = false
  }

  function stopSessionListRefresh() {
    if (sessionListRefreshTimer !== null) {
      window.clearTimeout(sessionListRefreshTimer)
      sessionListRefreshTimer = null
    }
  }

  async function apiFetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || undefined)
    if (sessionStore.hasAuthToken) {
      headers.set('Authorization', `Bearer ${sessionStore.authToken}`)
    }
    return fetch(input, {
      ...init,
      headers,
    })
  }

  async function ensureSessionsLoaded() {
    if (sessions.value.length === 0) {
      await sessionStore.fetchSessions()
    }
    if (!selectedSessionId.value && sessions.value.length > 0) {
      selectedSessionId.value = sessions.value[0]!.id
    }
  }

  async function refreshSessionList() {
    const loaded = await sessionStore.fetchSessions()
    if (!loaded) return false
    if (!selectedSessionId.value && sessions.value.length > 0) {
      selectedSessionId.value = sessions.value[0]!.id
    }
    return true
  }

  function scheduleSessionListRefresh() {
    stopSessionListRefresh()
    sessionListRefreshTimer = window.setTimeout(async () => {
      await refreshSessionList()
      scheduleSessionListRefresh()
    }, SESSION_LIST_REFRESH_INTERVAL_MS)
  }

  function startSessionListRefresh() {
    scheduleSessionListRefresh()
  }

  async function loadTransportLogs(sessionId: string, options: { cursor?: number | null; append?: boolean; follow?: boolean } = {}) {
    if (!sessionId || transportLogLoading.value) return false

    transportLogLoading.value = true
    transportLogRefreshing.value = !options.append
    try {
      const params = new URLSearchParams()
      params.set('limit', '100')
      if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
      if (options.follow) params.set('follow', '1')
      const res = await apiFetch(`/api/sessions/${sessionId}/transport-logs?${params.toString()}`)
      if (!res.ok) {
        logger.warn('transport:load:error', {
          sessionId: shortId(sessionId),
          status: res.status,
          cursor: options.cursor,
          follow: options.follow,
        })
        return false
      }
      const data = await res.json() as TransportLogsResponse
      const items = Array.isArray(data.items) ? data.items : []
      if (options.append) {
        transportLog.value = [...items, ...transportLog.value]
      } else if (options.follow) {
        transportLog.value = [...transportLog.value, ...items]
      } else {
        transportLog.value = items
      }
      transportLogHasMore.value = Boolean(data.hasMore)
      transportLogCursor.value = typeof data.nextCursor === 'number' ? data.nextCursor : null
      logger.info('transport:load:success', {
        sessionId: shortId(sessionId),
        count: items.length,
        total: transportLog.value.length,
        hasMore: transportLogHasMore.value,
        cursor: transportLogCursor.value,
        follow: options.follow,
      })
      return true
    } catch (error) {
      logger.error('transport:load:error', {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      transportLogLoading.value = false
      transportLogRefreshing.value = false
    }
  }

  async function reloadTransportLogs() {
    transportLog.value = []
    transportLogHasMore.value = false
    transportLogCursor.value = null
    stopTransportFollow()
    if (!selectedSessionId.value) return false
    const loaded = await loadTransportLogs(selectedSessionId.value)
    if (loaded && transportLogLive.value) {
      scheduleTransportFollow()
    }
    return loaded
  }

  async function refreshTransportLogs() {
    if (!selectedSessionId.value) return false
    const lastCursor = transportLog.value.length > 0 ? transportLog.value[transportLog.value.length - 1]?.cursor ?? null : null
    return loadTransportLogs(selectedSessionId.value, { cursor: lastCursor, follow: true })
  }

  async function loadOlderTransportLogs() {
    if (!selectedSessionId.value || !transportLogHasMore.value || transportLogCursor.value === null) return false
    return loadTransportLogs(selectedSessionId.value, { cursor: transportLogCursor.value, append: true })
  }

  function scheduleTransportFollow() {
    stopTransportFollow()
    if (!selectedSessionId.value || !transportLogLive.value) return
    transportLogFollowing.value = true
    transportFollowTimer = window.setTimeout(async () => {
      await refreshTransportLogs()
      scheduleTransportFollow()
    }, 1500)
  }

  async function setTransportLive(enabled: boolean) {
    transportLogLive.value = enabled
    if (!enabled) {
      stopTransportFollow()
      return false
    }
    if (!selectedSessionId.value) return false
    const loaded = await refreshTransportLogs()
    scheduleTransportFollow()
    return loaded
  }

  async function toggleTransportLive() {
    return setTransportLive(!transportLogLive.value)
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || selectedSessionId.value === sessionId) return
    selectedSessionId.value = sessionId
  }

  watch(selectedSessionId, async (next, prev) => {
    if (next && next !== prev) {
      await reloadTransportLogs()
    }
  })

  return {
    sessions,
    selectedSessionId,
    transportLog,
    transportLogHasMore,
    transportLogLoading,
    transportLogRefreshing,
    transportLogFollowing,
    transportLogLive,
    ensureSessionsLoaded,
    refreshSessionList,
    startSessionListRefresh,
    stopSessionListRefresh,
    selectSession,
    reloadTransportLogs,
    refreshTransportLogs,
    loadOlderTransportLogs,
    stopTransportFollow,
    setTransportLive,
    toggleTransportLive,
  }
})

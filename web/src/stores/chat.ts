import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ChatContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'unknown'
  text?: string
  name?: string
  toolUseId?: string
  input?: unknown
  output?: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  blocks?: ChatContentBlock[]
}

interface SessionListItem {
  id: string
  title: string
  updatedAt: number
}

interface ServerEvent {
  type?: string
  content?: any
  session_id?: string
  sessionId?: string
  result?: string
  message?: any
  subtype?: string
}

interface HealthResponse {
  status?: string
  authEnabled?: boolean
}

const AUTH_TOKEN_STORAGE_KEY = 'coffee-agent-auth-token'

function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = record.sessionId ?? record.session_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(stringifyStructuredValue).filter(Boolean).join('\n').trim()
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

function normalizeBlocksFromContent(content: unknown): ChatContentBlock[] {
  if (!Array.isArray(content)) return []

  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return { type: 'unknown' } satisfies ChatContentBlock
    }

    const item = block as Record<string, unknown>
    const type = typeof item.type === 'string' ? item.type : 'unknown'

    if (type === 'text') {
      return {
        type: 'text',
        text: typeof item.text === 'string' ? item.text : stringifyStructuredValue(item),
      } satisfies ChatContentBlock
    }

    if (type === 'tool_use') {
      return {
        type: 'tool_use',
        name: typeof item.name === 'string' ? item.name : 'unknown_tool',
        toolUseId: typeof item.id === 'string' ? item.id : undefined,
        input: item.input,
      } satisfies ChatContentBlock
    }

    if (type === 'tool_result') {
      return {
        type: 'tool_result',
        toolUseId: typeof item.tool_use_id === 'string' ? item.tool_use_id : undefined,
        output: item.content ?? item.result,
      } satisfies ChatContentBlock
    }

    if (type === 'thinking') {
      return {
        type: 'thinking',
        text: typeof item.thinking === 'string'
          ? item.thinking
          : typeof item.text === 'string'
            ? item.text
            : undefined,
      } satisfies ChatContentBlock
    }

    return { type: 'unknown' } satisfies ChatContentBlock
  })
}

function buildContentFromBlocks(blocks: ChatContentBlock[]): string {
  return blocks.map((block) => {
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
}

function normalizeAssistantPayload(payload: any): { content: string; blocks: ChatContentBlock[] } {
  if (!payload) return { content: '', blocks: [] }
  if (typeof payload.result === 'string') {
    return {
      content: payload.result,
      blocks: payload.result ? [{ type: 'text', text: payload.result }] : [],
    }
  }

  const message = payload.message
  if (!message || typeof message !== 'object') return { content: '', blocks: [] }

  const content = (message as Record<string, unknown>).content
  const blocks = normalizeBlocksFromContent(content)
  return {
    content: buildContentFromBlocks(blocks),
    blocks,
  }
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const sessions = ref<SessionListItem[]>([])
  const currentSessionId = ref<string | null>(null)
  const isConnected = ref(false)
  const isLoading = ref(false)
  const streamingContent = ref('')
  const streamingBlocks = ref<ChatContentBlock[]>([])
  const authToken = ref(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '')
  const authError = ref('')
  const authRequired = ref(false)
  const authChecked = ref(false)

  const hasAuthToken = computed(() => authToken.value.trim().length > 0)

  let ws: WebSocket | null = null

  function persistAuthToken(token: string) {
    authToken.value = token.trim()
    if (authToken.value) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken.value)
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    }
  }

  function resetStreamingState() {
    streamingContent.value = ''
    streamingBlocks.value = []
  }

  function clearConnection() {
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
    isConnected.value = false
  }

  async function checkHealth() {
    try {
      const res = await fetch('/api/health')
      const data = await res.json() as HealthResponse
      authRequired.value = Boolean(data.authEnabled)
    } catch {
      authRequired.value = false
    } finally {
      authChecked.value = true
    }
  }

  async function apiFetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || undefined)
    if (hasAuthToken.value) {
      headers.set('Authorization', `Bearer ${authToken.value}`)
    }

    const res = await fetch(input, {
      ...init,
      headers,
    })

    if (res.status === 401) {
      authError.value = '认证失败，请重新输入访问令牌。'
      isConnected.value = false
    }

    return res
  }

  function connect() {
    if (authRequired.value && !hasAuthToken.value) {
      authError.value = '请输入访问令牌。'
      return
    }

    clearConnection()
    authError.value = ''

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = new URL(`${protocol}//${location.host}/ws`)
    if (hasAuthToken.value) {
      wsUrl.searchParams.set('auth', authToken.value)
    }

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      isConnected.value = true
      authError.value = ''
    }

    ws.onclose = () => {
      isConnected.value = false
      ws = null
      if (hasAuthToken.value && !authError.value) {
        setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => {
      isConnected.value = false
      if (authRequired.value && hasAuthToken.value) {
        authError.value = '连接失败，请检查访问令牌是否正确。'
      }
    }

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data)
        handleServerMessage(data)
      } catch {
        // ignore malformed messages
      }
    }
  }

  function handleServerMessage(data: any) {
    switch (data.type) {
      case 'status':
        break

      case 'event': {
        const event = data.event as ServerEvent
        const sessionId = extractSessionId(event) || extractSessionId(event?.content)
        if (sessionId) {
          currentSessionId.value = sessionId
        }

        if (event?.type === 'assistant') {
          const normalized = normalizeAssistantPayload(event.content)
          streamingBlocks.value = normalized.blocks
          streamingContent.value = normalized.content
        }
        break
      }

      case 'done': {
        if (streamingContent.value || streamingBlocks.value.length > 0) {
          messages.value.push({
            role: 'assistant',
            content: streamingContent.value,
            timestamp: Date.now(),
            blocks: streamingBlocks.value,
          })
        }
        resetStreamingState()
        isLoading.value = false
        if (data.sessionId) {
          currentSessionId.value = data.sessionId
        }
        fetchSessions()
        break
      }

      case 'error':
        messages.value.push({
          role: 'system',
          content: `Error: ${data.error}`,
          timestamp: Date.now(),
        })
        isLoading.value = false
        resetStreamingState()
        break
    }
  }

  function sendMessage(prompt: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !prompt.trim()) return

    messages.value.push({
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    })

    isLoading.value = true
    resetStreamingState()

    ws.send(
      JSON.stringify({
        action: 'chat',
        prompt,
        ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
      })
    )
  }

  async function fetchSessions(): Promise<boolean> {
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) return false
      const data = await res.json()
      sessions.value = (data.sessions || []).map((s: any) => ({
        id: s.id,
        title: s.title || s.id?.slice(0, 8) || 'Untitled',
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      }))
      return true
    } catch {
      return false
    }
  }

  function newChat() {
    currentSessionId.value = null
    messages.value = []
    resetStreamingState()
  }

  function selectSession(id: string) {
    currentSessionId.value = id
    messages.value = []
    resetStreamingState()
    loadSessionMessages(id)
  }

  async function loadSessionMessages(id: string) {
    try {
      const res = await apiFetch(`/api/sessions/${id}/messages`)
      if (!res.ok) return
      const data = await res.json()
      messages.value = (data.messages || []).map((m: any) => ({
        role: m.role || 'assistant',
        content: m.content || '',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        blocks: Array.isArray(m.blocks) ? m.blocks : undefined,
      }))
    } catch {
      // silent fail
    }
  }

  async function initialize() {
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
    persistAuthToken('')
    clearConnection()
    authError.value = ''
    currentSessionId.value = null
    messages.value = []
    sessions.value = []
    resetStreamingState()
  }

  return {
    messages,
    sessions,
    currentSessionId,
    isConnected,
    isLoading,
    streamingContent,
    streamingBlocks,
    authToken,
    authError,
    authRequired,
    authChecked,
    hasAuthToken,
    connect,
    sendMessage,
    fetchSessions,
    newChat,
    selectSession,
    initialize,
    setAuthToken,
    clearAuthToken,
  }
})

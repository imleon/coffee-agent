import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { StaticMetadataSnapshot, StaticMetadataTreeNode } from '../../../shared/message-types.js'
import { createDebugLogger } from '../lib/debug.js'
import { useSessionStore } from './session'

const logger = createDebugLogger('static-metadata-store')

interface StaticMetadataResponse {
  generatedAt?: number
  groups?: StaticMetadataTreeNode[]
  error?: string
}

export const useStaticMetadataStore = defineStore('static-metadata', () => {
  const sessionStore = useSessionStore()
  const generatedAt = ref<number | null>(null)
  const groups = ref<StaticMetadataTreeNode[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  const hasData = computed(() => groups.value.length > 0)

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

  async function load(force = false): Promise<boolean> {
    if (loading.value) return false
    if (!force && loaded.value) return true

    loading.value = true
    error.value = ''
    try {
      const res = await apiFetch('/api/static-metadata')
      if (!res.ok) {
        error.value = res.status === 401 ? '认证失败，请重新输入访问令牌。' : `加载失败 (${res.status})`
        logger.warn('static-metadata:load:error', { status: res.status })
        return false
      }

      const data = await res.json() as StaticMetadataResponse
      generatedAt.value = typeof data.generatedAt === 'number' ? data.generatedAt : Date.now()
      groups.value = Array.isArray(data.groups) ? data.groups : []
      error.value = typeof data.error === 'string' ? data.error : ''
      loaded.value = true
      logger.info('static-metadata:load:success', {
        groups: groups.value.length,
      })
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      logger.error('static-metadata:load:error', {
        error: error.value,
      })
      return false
    } finally {
      loading.value = false
    }
  }

  function reset() {
    generatedAt.value = null
    groups.value = []
    loading.value = false
    loaded.value = false
    error.value = ''
  }

  const snapshot = computed<StaticMetadataSnapshot>(() => ({
    generatedAt: generatedAt.value ?? Date.now(),
    groups: groups.value,
  }))

  return {
    generatedAt,
    groups,
    snapshot,
    loading,
    loaded,
    hasData,
    error,
    load,
    reset,
  }
})

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLogViewStore } from '../stores/log-view'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'

const logView = useLogViewStore()
const transportItems = computed(() => logView.transportLog)
const sortedSessions = computed(() => (
  [...logView.sessions].sort((left, right) => {
    const leftTime = typeof left.updatedAt === 'number' && Number.isFinite(left.updatedAt) ? left.updatedAt : 0
    const rightTime = typeof right.updatedAt === 'number' && Number.isFinite(right.updatedAt) ? right.updatedAt : 0
    return rightTime - leftTime
  })
))
const preservingOlderScroll = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)
const scrollToLatestPending = ref(true)

function getTransportDirectionLabel(direction: string): string {
  return direction === 'inbound' ? 'IN' : 'OUT'
}

function getTransportTitle(item: { event: { eventName: string; sdkType?: string; sdkSubtype?: string } }): string {
  const { eventName, sdkType, sdkSubtype } = item.event
  if (eventName === 'message') {
    if (!sdkType) return 'message'
    return sdkSubtype ? `${sdkType}.${sdkSubtype}` : sdkType
  }
  return eventName
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const base = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date)
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0')
  return `${base}.${milliseconds}`
}

function formatSessionActivity(timestamp?: number): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '----/--/-- --:--'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '----/--/-- --:--'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '/')
}

function getDirectionClass(direction: string): string {
  return direction === 'inbound'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : 'border-violet-200 bg-violet-50 text-violet-700'
}

function getEventTagClass(eventName: string): string {
  if (eventName === 'message') return 'border-sky-200 bg-sky-50 text-sky-700'
  if (eventName.startsWith('query.')) return 'border-amber-200 bg-amber-50 text-amber-700'
  if (eventName.startsWith('control.')) return 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700'
  return 'border-gray-200 bg-gray-100 text-gray-700'
}

const liveButtonClass = computed(() => (
  logView.transportLogLive
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
    : 'border-amber-300 bg-amber-50 text-amber-700'
))

const liveButtonLabel = computed(() => {
  if (logView.transportLogLive) {
    return logView.transportLogRefreshing ? 'LIVE · SYNCING' : 'LIVE'
  }
  return 'PAUSED'
})

async function scrollToBottom() {
  await nextTick()
  const container = scrollContainer.value
  if (!container) return
  container.scrollTop = container.scrollHeight
}

async function handleScroll() {
  const container = scrollContainer.value
  if (!container || container.scrollTop > 120) return
  if (!logView.transportLogHasMore || logView.transportLogLoading) return

  preservingOlderScroll.value = true
  const previousHeight = container.scrollHeight
  const previousTop = container.scrollTop
  const loaded = await logView.loadOlderTransportLogs()
  if (!loaded) {
    preservingOlderScroll.value = false
    return
  }

  await nextTick()
  const nextHeight = container.scrollHeight
  container.scrollTop = nextHeight - previousHeight + previousTop
  preservingOlderScroll.value = false
}

watch(() => logView.selectedSessionId, (next, prev) => {
  if (next && next !== prev) {
    scrollToLatestPending.value = true
  }
})

watch(() => transportItems.value.length, async (next, prev) => {
  if (next === prev || preservingOlderScroll.value || next === 0) return
  if (scrollToLatestPending.value) {
    scrollToLatestPending.value = false
    await scrollToBottom()
    return
  }
  if (logView.transportLogLive && next > prev) {
    await scrollToBottom()
  }
})

onMounted(() => {
  logView.startSessionListRefresh()
  logView.ensureSessionsLoaded().then(() => {
    if (logView.selectedSessionId) {
      scrollToLatestPending.value = true
      void logView.reloadTransportLogs()
    }
  })
})

onBeforeUnmount(() => {
  logView.stopSessionListRefresh()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-gray-50 p-3">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-2">
      <div class="border-b border-gray-200 pb-2">
        <h2 class="text-sm font-semibold text-gray-900">SDK transport log</h2>
        <p class="mt-0.5 text-[11px] text-gray-500">Log 模块独立选择 session，不跟主聊天联动。</p>
      </div>

      <div class="flex items-center justify-between gap-2 pb-1">
        <div class="flex min-w-0 items-center gap-2">
          <select
            :value="logView.selectedSessionId || ''"
            class="min-w-[32rem] max-w-[40rem] rounded border border-gray-300 bg-white px-2 py-1 font-mono text-[11px] text-gray-700"
            @change="logView.selectSession(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>选择 session</option>
            <option v-for="item in sortedSessions" :key="item.id" :value="item.id">
              {{ formatSessionActivity(item.updatedAt) }}  {{ item.title }}
            </option>
          </select>
          <div class="truncate text-[11px] text-gray-500">
            <span class="text-gray-400">session:</span>
            <span class="ml-1 text-gray-800">{{ logView.selectedSessionId || 'none' }}</span>
          </div>
        </div>
        <button
          class="rounded border px-2 py-1 text-[11px] font-semibold tracking-wide disabled:cursor-not-allowed disabled:opacity-50"
          :class="liveButtonClass"
          :disabled="!logView.selectedSessionId || logView.transportLogLoading"
          @click="logView.toggleTransportLive"
        >
          {{ liveButtonLabel }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden rounded border border-gray-200 bg-white font-mono">
        <div v-if="transportItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
          No SDK transport logs yet.
        </div>

        <div v-else ref="scrollContainer" class="h-full overflow-y-auto" @scroll="handleScroll">
          <div class="sticky top-0 z-10 grid grid-cols-[28ch_6ch_18ch_10ch_14ch_18ch_18ch_10ch_minmax(0,1fr)] gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2 text-[10px] uppercase tracking-wide text-gray-500">
            <div>Timestamp</div>
            <div>Dir</div>
            <div>Event</div>
            <div>Seq</div>
            <div>Run</div>
            <div>Request</div>
            <div>ToolUse</div>
            <div>Cursor</div>
            <div>Details</div>
          </div>
          <div
            v-for="item in transportItems"
            :key="`sdk-transport-${item.cursor}`"
            class="grid grid-cols-[28ch_6ch_18ch_10ch_14ch_18ch_18ch_10ch_minmax(0,1fr)] gap-3 border-b border-gray-100 px-3 py-2 text-[11px] leading-5 transition-colors hover:bg-gray-50 last:border-b-0"
          >
            <div class="shrink-0 whitespace-nowrap text-gray-500">{{ formatTimestamp(item.event.receivedAt) }}</div>
            <div>
              <span class="inline-flex min-w-[3.5ch] justify-center rounded border px-1.5 py-0 font-medium" :class="getDirectionClass(item.event.direction)">
                {{ getTransportDirectionLabel(item.event.direction) }}
              </span>
            </div>
            <div>
              <span class="inline-flex max-w-full truncate rounded border px-1.5 py-0 font-medium" :class="getEventTagClass(item.event.eventName)">
                {{ item.event.eventName }}
              </span>
            </div>
            <div class="shrink-0 text-gray-400">#{{ item.event.sequence }}</div>
            <div class="shrink-0 text-gray-400">{{ item.runId.slice(0, 8) }}</div>
            <div class="truncate text-gray-500">{{ item.event.requestId || '-' }}</div>
            <div class="truncate text-gray-500">{{ item.event.toolUseId || '-' }}</div>
            <div class="shrink-0 text-gray-500">{{ item.cursor }}</div>
            <div class="min-w-0">
              <div class="truncate font-medium text-gray-900">{{ getTransportTitle(item) }}</div>
              <div v-if="item.event.payloadSummary" class="truncate text-gray-700">
                {{ item.event.payloadSummary }}
              </div>
              <details v-if="item.event.payload !== undefined" class="mt-1">
                <summary class="cursor-pointer text-gray-500 hover:text-gray-700">Raw payload</summary>
                <pre class="mt-1 overflow-x-auto border border-gray-200 bg-gray-950 px-2 py-2 text-[11px] text-gray-100">{{ stringifyStructuredValue(item.event.payload) }}</pre>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

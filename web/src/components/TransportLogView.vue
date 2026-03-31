<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../stores/session'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'

const session = useSessionStore()
const transportItems = computed(() => session.sdkTransportEvents.slice().reverse())

function getTransportDirectionLabel(direction: string): string {
  return direction === 'inbound' ? 'Inbound' : 'Outbound'
}

function getTransportTitle(item: { event: { eventName: string; sdkType?: string; sdkSubtype?: string } }): string {
  const { eventName, sdkType, sdkSubtype } = item.event
  if (eventName === 'message') {
    if (!sdkType) return 'message'
    return sdkSubtype ? `${sdkType}.${sdkSubtype}` : sdkType
  }
  return eventName
}

function getTransportMeta(item: { event: { sequence: number; receivedAt: number; direction: string; requestId?: string; toolUseId?: string } }): string {
  const parts = [
    `${getTransportDirectionLabel(item.event.direction)} · seq=${item.event.sequence}`,
    `time=${item.event.receivedAt}`,
  ]
  if (item.event.requestId) parts.push(`request=${item.event.requestId}`)
  if (item.event.toolUseId) parts.push(`toolUse=${item.event.toolUseId}`)
  return parts.join(' ')
}
</script>

<template>
  <div class="flex-1 overflow-y-auto p-6">
    <div class="mx-auto max-w-5xl space-y-4">
      <div class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold text-gray-900">SDK transport log</h2>
            <p class="mt-1 text-sm text-gray-500">
              当前 session 的 Claude Agent SDK inbound / outbound I/O。
            </p>
          </div>
          <div class="text-right text-xs text-gray-500">
            <div>Run state: {{ session.runState }}</div>
            <div>Session: {{ session.currentSessionId || 'new' }}</div>
            <div>Events: {{ session.sdkTransportEvents.length }}</div>
          </div>
        </div>
      </div>

      <div
        v-if="transportItems.length === 0"
        class="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500"
      >
        No SDK transport logs yet.
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="item in transportItems"
          :key="`sdk-transport-${item.event.sequence}`"
          class="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
        >
          <div class="font-medium">{{ getTransportTitle(item) }}</div>
          <div class="mt-1 text-[11px] text-sky-700">{{ getTransportMeta(item) }}</div>
          <div v-if="item.event.payloadSummary" class="mt-2 whitespace-pre-wrap text-xs text-sky-900">
            {{ item.event.payloadSummary }}
          </div>
          <details v-if="item.event.payload !== undefined" class="mt-2">
            <summary class="cursor-pointer text-[11px] text-sky-700">Raw payload</summary>
            <pre class="mt-2 whitespace-pre-wrap text-xs text-sky-950">{{ stringifyStructuredValue(item.event.payload) }}</pre>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

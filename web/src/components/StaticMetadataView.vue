<script setup lang="ts">
import { computed, onMounted } from 'vue'
import StaticMetadataNode from './StaticMetadataNode.vue'
import { useStaticMetadataStore } from '../stores/static-metadata'

const metadata = useStaticMetadataStore()
const groups = computed(() => metadata.groups)

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

onMounted(() => {
  void metadata.load()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-gray-50 p-4">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3">
      <div class="flex items-start justify-between gap-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">Static metadata</h2>
          <p class="mt-1 text-xs text-gray-500">无 session 字段树。没有值时仅展示字段名与来源。</p>
          <p class="mt-1 text-[11px] text-gray-500">generated: {{ formatTimestamp(metadata.generatedAt) }}</p>
        </div>
        <button
          class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="metadata.loading"
          @click="metadata.load(true)"
        >
          {{ metadata.loading ? 'Loading...' : 'Refresh' }}
        </button>
      </div>

      <div v-if="metadata.error" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ metadata.error }}
      </div>

      <div v-if="!metadata.loading && !metadata.hasData" class="flex flex-1 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500">
        No static metadata yet.
      </div>

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <div class="space-y-3 pb-4">
          <StaticMetadataNode v-for="group in groups" :key="group.path" :node="group" />
        </div>
      </div>
    </div>
  </div>
</template>

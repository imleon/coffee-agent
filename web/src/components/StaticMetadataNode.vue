<script setup lang="ts">
import { computed } from 'vue'
import type { StaticMetadataTreeNode } from '../../../shared/message-types.js'

defineOptions({ name: 'StaticMetadataNode' })

const props = withDefaults(defineProps<{
  node: StaticMetadataTreeNode
  depth?: number
}>(), {
  depth: 0,
})

const hasChildren = computed(() => Array.isArray(props.node.children) && props.node.children.length > 0)
const isExpandable = computed(() => hasChildren.value)
const openByDefault = computed(() => props.depth <= 1)

function formatValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function getStatusClass(status: StaticMetadataTreeNode['status']): string {
  if (status === 'resolved') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'session-required') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-gray-200 bg-gray-100 text-gray-600'
}

function getKindClass(kind: StaticMetadataTreeNode['kind']): string {
  if (kind === 'group') return 'border-sky-200 bg-sky-50 text-sky-700'
  if (kind === 'object' || kind === 'array') return 'border-violet-200 bg-violet-50 text-violet-700'
  return 'border-gray-200 bg-white text-gray-500'
}
</script>

<template>
  <details v-if="isExpandable" :open="openByDefault" class="rounded-lg border border-gray-200 bg-white">
    <summary class="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-gray-900">{{ node.label }}</span>
          <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide" :class="getKindClass(node.kind)">{{ node.kind }}</span>
          <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide" :class="getStatusClass(node.status)">{{ node.status }}</span>
          <span v-if="node.requiresSession" class="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700">requires session</span>
        </div>
        <div class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ node.path }}</div>
        <div v-if="node.description" class="mt-1 text-xs text-gray-600">{{ node.description }}</div>
        <div v-if="node.source" class="mt-1 text-[11px] text-gray-500">source: {{ node.source }}</div>
      </div>
      <div class="shrink-0 text-[11px] text-gray-400">{{ node.children?.length || 0 }} children</div>
    </summary>

    <div class="space-y-3 border-t border-gray-100 px-3 py-3">
      <div v-if="node.value !== undefined && (node.kind === 'object' || node.kind === 'array')" class="rounded border border-gray-100 bg-gray-50 p-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">Current value</div>
        <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-gray-700">{{ formatValue(node.value) }}</pre>
      </div>
      <StaticMetadataNode v-for="child in node.children" :key="child.path" :node="child" :depth="depth + 1" />
    </div>
  </details>

  <div v-else class="rounded-lg border border-gray-200 bg-white px-4 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-medium text-gray-900">{{ node.label }}</span>
      <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide" :class="getKindClass(node.kind)">{{ node.kind }}</span>
      <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide" :class="getStatusClass(node.status)">{{ node.status }}</span>
      <span v-if="node.requiresSession" class="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700">requires session</span>
    </div>
    <div class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ node.path }}</div>
    <div v-if="node.description" class="mt-1 text-xs text-gray-600">{{ node.description }}</div>
    <div v-if="node.source" class="mt-1 text-[11px] text-gray-500">source: {{ node.source }}</div>
    <div v-if="node.meta" class="mt-2 rounded border border-gray-100 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-600">
      {{ formatValue(node.meta) }}
    </div>
    <div v-if="node.value !== undefined" class="mt-2 rounded border border-gray-100 bg-gray-50 p-3">
      <pre class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-gray-700">{{ formatValue(node.value) }}</pre>
    </div>
  </div>
</template>

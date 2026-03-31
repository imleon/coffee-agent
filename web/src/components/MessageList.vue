<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  useSessionStore,
  type SessionMessage,
  type SessionMessageBlock,
  type TimelineItem,
} from '../stores/session'
import {
  normalizeSdkEnvelopeMessage,
  stringifyStructuredValue,
} from '../../../shared/transcript-normalizer.js'

const session = useSessionStore()
const container = ref<HTMLElement>()
const elicitationInput = ref('')
const telemetryItems = computed(() => session.telemetry.slice().reverse())
const timelineItems = computed(() => session.timeline)
const pendingInteractionTitle = computed(() => {
  const interaction = session.pendingInteraction
  if (!interaction) return 'Pending interaction'
  if (interaction.kind === 'permission') {
    return interaction.title || interaction.displayName || interaction.toolName || 'Pending interaction'
  }
  return interaction.serverName || 'Pending interaction'
})
const pendingInteractionDescription = computed(() => {
  const interaction = session.pendingInteraction
  if (!interaction) return ''
  return interaction.kind === 'permission'
    ? interaction.description || ''
    : interaction.message || ''
})
const pendingInteractionReason = computed(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction.decisionReason || '' : ''
)
const pendingInteractionInput = computed(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction.input : undefined
)
const pendingInteractionUrl = computed(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction.url : undefined
)
const pendingInteractionSchema = computed(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction.requestedSchema : undefined
)

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}

function hasBlocks(blocks?: SessionMessageBlock[]): boolean {
  return Array.isArray(blocks) && blocks.length > 0
}

function normalizeLegacyMessage(payload: unknown): SessionMessage | null {
  return normalizeSdkEnvelopeMessage(payload) as SessionMessage | null
}

function getTimelineMessage(item: TimelineItem): SessionMessage | null {
  if (item.kind === 'history-message') return item.message
  return item.event.parsed ?? normalizeLegacyMessage(item.event.payload)
}

function getPayloadType(item: TimelineItem): string {
  if (item.kind === 'history-message') return item.message.role
  const payload = item.event.payload as Record<string, unknown> | null | undefined
  const type = payload && typeof payload.type === 'string' ? payload.type : 'unknown'
  const subtype = payload && typeof payload.subtype === 'string' ? payload.subtype : ''
  return subtype ? `${type}.${subtype}` : type
}

function isUserTimelineItem(item: TimelineItem): boolean {
  if (item.kind === 'history-message') return item.message.role === 'user'
  return item.event.payload?.type === 'user'
}

function submitElicitation() {
  if (session.pendingInteraction?.kind !== 'elicitation') return

  const text = elicitationInput.value.trim()
  if (!text) {
    session.respondToElicitation({ action: 'accept', content: {} })
    return
  }

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid elicitation payload')
    }
    const normalized: Record<string, string | number | boolean | string[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        normalized[key] = value
        continue
      }
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        normalized[key] = value
      }
    }
    session.respondToElicitation({ action: 'accept', content: normalized })
  } catch {
    session.respondToElicitation({ action: 'accept', content: { value: text } })
  }

  elicitationInput.value = ''
}

watch(
  () => [session.timeline.length, session.telemetry.length, session.pendingInteraction?.id],
  async () => {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  },
  { deep: true }
)

watch(
  () => session.pendingInteraction?.id,
  () => {
    elicitationInput.value = ''
  }
)
</script>

<template>
  <div ref="container" class="flex-1 overflow-y-auto p-6 space-y-4">
    <div
      v-if="session.timeline.length === 0"
      class="flex items-center justify-center h-full text-gray-400"
    >
      <div class="text-center">
        <p class="text-4xl mb-4">C</p>
        <p class="text-lg">Inspect SDK-native interactions in Cotta</p>
      </div>
    </div>

    <div
      v-for="item in timelineItems"
      :key="item.key"
      class="flex"
      :class="isUserTimelineItem(item) ? 'justify-end' : 'justify-start'"
    >
      <div
        class="max-w-[75%] rounded-2xl px-4 py-3"
        :class="
          getTimelineMessage(item)?.role === 'user'
            ? 'bg-blue-600 text-white'
            : getTimelineMessage(item)?.role === 'system'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-white border border-gray-200 shadow-sm'
        "
      >
        <div class="mb-2 text-[11px] uppercase tracking-wide opacity-60">
          {{ getPayloadType(item) }}
          <span v-if="item.kind === 'sdk-message'">· seq={{ item.event.sequence }}</span>
        </div>
        <template v-if="getTimelineMessage(item)?.role === 'assistant' && hasBlocks(getTimelineMessage(item)?.blocks)">
          <div
            v-for="(block, blockIndex) in getTimelineMessage(item)?.blocks || []"
            :key="`${item.key}-${blockIndex}`"
            class="mb-3 last:mb-0"
          >
            <div
              v-if="block.type === 'text'"
              class="markdown-body prose prose-sm max-w-none"
              v-html="renderMarkdown(block.text || '')"
            />
            <div
              v-else-if="block.type === 'tool_use'"
              class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"
            >
              <div class="font-medium">Tool: {{ block.name || 'unknown_tool' }}</div>
              <pre
                v-if="block.input"
                class="mt-2 whitespace-pre-wrap text-xs text-blue-900"
              >{{ stringifyStructuredValue(block.input) }}</pre>
            </div>
            <div
              v-else-if="block.type === 'tool_result'"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              <div class="font-medium">Tool result</div>
              <pre
                v-if="block.output"
                class="mt-2 whitespace-pre-wrap text-xs text-gray-800"
              >{{ stringifyStructuredValue(block.output) }}</pre>
            </div>
            <div
              v-else-if="block.type === 'thinking'"
              class="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-purple-800"
            >
              <div class="font-medium">Thinking</div>
              <pre class="mt-2 whitespace-pre-wrap text-xs text-purple-900">{{ block.text }}</pre>
            </div>
            <div
              v-else
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              <div class="font-medium">Unknown block</div>
              <pre class="mt-2 whitespace-pre-wrap text-xs text-gray-800">{{ stringifyStructuredValue(block.raw) }}</pre>
            </div>
          </div>
        </template>
        <div
          v-else-if="getTimelineMessage(item)?.role === 'assistant'"
          class="markdown-body prose prose-sm max-w-none"
          v-html="renderMarkdown(getTimelineMessage(item)?.content || '')"
        />
        <div v-else-if="getTimelineMessage(item)" class="whitespace-pre-wrap">{{ getTimelineMessage(item)?.content }}</div>
        <pre
          v-else-if="item.kind === 'sdk-message'"
          class="whitespace-pre-wrap text-xs text-gray-800"
        >{{ stringifyStructuredValue(item.event.payload) }}</pre>
      </div>
    </div>

    <div v-if="session.pendingInteraction" class="flex justify-start">
      <div class="max-w-[75%] rounded-2xl px-4 py-3 shadow-sm"
        :class="session.pendingInteraction.kind === 'permission' ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-indigo-50 border border-indigo-200 text-indigo-900'"
      >
        <div class="font-medium">
          {{ session.pendingInteraction.kind === 'permission' ? 'Permission required' : 'Interaction required' }}
        </div>
        <div class="mt-1 text-sm">
          {{ pendingInteractionTitle }}
        </div>
        <div v-if="pendingInteractionDescription" class="mt-2 text-sm">
          {{ pendingInteractionDescription }}
        </div>
        <div v-if="pendingInteractionReason" class="mt-2 text-xs opacity-80">{{ pendingInteractionReason }}</div>
        <pre v-if="pendingInteractionInput" class="mt-3 whitespace-pre-wrap text-xs">{{ stringifyStructuredValue(pendingInteractionInput) }}</pre>
        <a
          v-if="pendingInteractionUrl"
          :href="pendingInteractionUrl"
          target="_blank"
          rel="noreferrer"
          class="mt-3 inline-flex text-sm underline"
        >
          Open interaction URL
        </a>
        <div v-if="session.pendingInteraction.kind === 'permission'" class="mt-3 flex gap-2">
          <button
            class="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors"
            @click="session.respondToPermission('approve')"
          >
            Allow
          </button>
          <button
            class="px-3 py-2 rounded-lg border border-amber-300 text-amber-900 text-sm font-medium hover:bg-amber-100 transition-colors"
            @click="session.respondToPermission('deny')"
          >
            Deny
          </button>
        </div>
        <div v-else class="mt-3 space-y-3">
          <div class="text-xs opacity-80">
            当前提供最小闭环输入。可直接填写 JSON；若不是 JSON，将作为 value 字段提交。
          </div>
          <pre v-if="pendingInteractionSchema" class="whitespace-pre-wrap text-xs">{{ stringifyStructuredValue(pendingInteractionSchema) }}</pre>
          <textarea
            v-model="elicitationInput"
            rows="4"
            class="w-full resize-y rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm"
            placeholder='{"key":"value"} 或直接输入文本'
          />
          <div class="flex gap-2">
            <button
              class="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
              @click="submitElicitation"
            >
              Submit
            </button>
            <button
              class="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-900 text-sm font-medium hover:bg-indigo-100 transition-colors"
              @click="session.respondToElicitation({ action: 'cancel' })"
            >
              Cancel interaction
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="telemetryItems.length > 0" class="space-y-2">
      <div class="text-xs font-medium uppercase tracking-wide text-gray-400">SDK event log</div>
      <div
        v-for="(item, idx) in telemetryItems"
        :key="`telemetry-${idx}`"
        class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
      >
        <div class="font-medium text-gray-900">{{ item.payload?.type || 'unknown' }}</div>
        <div class="mt-1 text-[11px] text-gray-500">seq={{ item.sequence }} time={{ item.receivedAt }}</div>
        <pre class="mt-2 whitespace-pre-wrap">{{ stringifyStructuredValue(item.payload) }}</pre>
      </div>
    </div>

    <div v-if="session.isLoading" class="flex justify-start">
      <div class="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
        <div class="flex space-x-1.5">
          <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0ms" />
          <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 150ms" />
          <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 300ms" />
        </div>
      </div>
    </div>
  </div>
</template>

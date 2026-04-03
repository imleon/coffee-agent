<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  useSessionStore,
  type HistoryAssistantThreadItem,
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
const runStateItems = computed(() => session.runStateEvents.slice().reverse())
const observabilityItems = computed(() => session.observabilityEvents.slice().reverse())
const timelineItems = computed(() => session.timeline)
const visibleTimelineItems = computed(() => timelineItems.value)
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

function formatTimelineTimestamp(timestamp?: number): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'time=unknown'

  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function getRunStateLabel(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return 'Run state event'

  if (payload.type === 'result') {
    const subtype = typeof payload.subtype === 'string' ? payload.subtype : 'result'
    return subtype === 'success' ? 'Run completed' : `Run ${subtype}`
  }

  if (payload.type === 'tool_progress') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown_tool'
    return `Tool running · ${toolName}`
  }

  if (payload.type === 'tool_use_summary') {
    return 'Tool summary'
  }

  if (payload.type === 'system') {
    const subtype = typeof payload.subtype === 'string' ? payload.subtype : 'system'
    switch (subtype) {
      case 'session_state_changed':
        return `Session state · ${typeof payload.state === 'string' ? payload.state : 'unknown'}`
      case 'status':
        return `Status · ${typeof payload.status === 'string' ? payload.status : 'unknown'}`
      case 'task_started':
        return 'Task started'
      case 'task_progress':
        return 'Task progress'
      case 'task_notification':
        return 'Task notification'
      default:
        return `System · ${subtype}`
    }
  }

  return typeof payload.type === 'string' ? payload.type : 'Run state event'
}

function getRunStateSummary(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return ''

  if (payload.type === 'result') {
    if (typeof payload.result === 'string' && payload.result.trim()) return payload.result
    const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : []
    return errors.join('\n')
  }

  if (payload.type === 'tool_progress') {
    const elapsed = typeof payload.elapsed_time_seconds === 'number' ? `${payload.elapsed_time_seconds}s` : ''
    return elapsed ? `Elapsed ${elapsed}` : ''
  }

  if (payload.type === 'tool_use_summary') {
    return typeof payload.summary === 'string' ? payload.summary : ''
  }

  if (payload.type === 'system') {
    switch (payload.subtype) {
      case 'task_started':
      case 'task_progress':
        return typeof payload.description === 'string' ? payload.description : ''
      case 'task_notification':
        return typeof payload.summary === 'string' ? payload.summary : ''
      default:
        return ''
    }
  }

  return ''
}

function getEventMeta(item: { sequence: number; receivedAt: number }): string {
  return `seq=${item.sequence} time=${item.receivedAt}`
}

function getEventPayload(item: { payload: unknown }): string {
  return stringifyStructuredValue(item.payload)
}

function renderObservabilityTitle(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return 'unknown'
  const type = typeof payload.type === 'string' ? payload.type : 'unknown'
  const subtype = typeof payload.subtype === 'string' ? payload.subtype : ''
  return subtype ? `${type}.${subtype}` : type
}

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}

function renderToolResultOutput(output: unknown): string {
  return stringifyStructuredValue(output)
}

function hasBlocks(blocks?: SessionMessageBlock[]): boolean {
  return Array.isArray(blocks) && blocks.length > 0
}

function hasRenderableBlocks(message: SessionMessage | null | undefined): boolean {
  return hasBlocks(message?.blocks)
}


function normalizeLegacyMessage(payload: unknown): SessionMessage | null {
  return normalizeSdkEnvelopeMessage(payload) as SessionMessage | null
}

function getTimelineMessage(item: TimelineItem): SessionMessage | null {
  if (item.kind === 'history-user-message' || item.kind === 'history-message') return item.message
  if (item.kind === 'history-assistant-thread') return item.rootMessage
  return item.event.parsed ?? normalizeLegacyMessage(item.event.payload)
}

function getPayloadType(item: TimelineItem): string {
  if (item.kind === 'history-user-message' || item.kind === 'history-message') return item.message.role
  if (item.kind === 'history-assistant-thread') return 'assistant thread'
  const payload = item.event.payload as Record<string, unknown> | null | undefined
  const type = payload && typeof payload.type === 'string' ? payload.type : 'unknown'
  const subtype = payload && typeof payload.subtype === 'string' ? payload.subtype : ''
  return subtype ? `${type}.${subtype}` : type
}

function isHistoryThreadItem(item: TimelineItem): boolean {
  return item.kind === 'history-assistant-thread'
}

function getHistoryThreadType(item: TimelineItem): string {
  if (item.kind !== 'history-assistant-thread') return getPayloadType(item)
  return 'assistant'
}

function getHistoryThreadItems(item: TimelineItem): HistoryAssistantThreadItem[] {
  return item.kind === 'history-assistant-thread' ? item.items : []
}

function getThreadItemStyle(_item: HistoryAssistantThreadItem): Record<string, string> {
  return {}
}

function getHistoryThreadLastMessage(item: TimelineItem): SessionMessage | null {
  if (item.kind !== 'history-assistant-thread') return null
  return item.items[item.items.length - 1]?.message ?? item.rootMessage
}

function getAssistantRawMessage(message: SessionMessage | null | undefined): Record<string, unknown> | null {
  const raw = message?.raw
  if (!raw || typeof raw !== 'object') return null
  const rawMessage = (raw as Record<string, unknown>).message
  return rawMessage && typeof rawMessage === 'object' ? rawMessage as Record<string, unknown> : null
}

function getAssistantUsageValue(message: SessionMessage | null | undefined, key: string): number | null {
  const rawMessage = getAssistantRawMessage(message)
  if (!rawMessage) return null
  const usage = rawMessage.usage
  if (!usage || typeof usage !== 'object') return null
  const value = (usage as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getAssistantModelName(message: SessionMessage | null | undefined): string {
  const rawMessage = getAssistantRawMessage(message)
  if (!rawMessage) return 'unknown'
  const model = rawMessage.model
  if (typeof model !== 'string' || !model) return 'unknown'
  const parts = model.split('/')
  return parts[parts.length - 1] || model
}

function getAssistantStopReason(message: SessionMessage | null | undefined): string {
  const rawMessage = getAssistantRawMessage(message)
  if (!rawMessage) return 'unknown'
  const stopReason = rawMessage.stop_reason
  return typeof stopReason === 'string' && stopReason ? stopReason : 'unknown'
}

function formatCompactNumber(value: number | null): string {
  if (value === null) return '-'
  if (value < 1000) return String(value)
  if (value < 10_000) return `${Math.round((value / 1000) * 10) / 10}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${Math.round((value / 1_000_000) * 10) / 10}m`
}

function formatDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function getHistoryCardClass(item: TimelineItem): string {
  if (item.kind === 'history-message' || item.kind === 'history-assistant-thread') {
    return 'bg-white border border-gray-200 shadow-sm'
  }
  return getMessageClass(getTimelineMessage(item))
}

function getHistoryCardFooter(item: TimelineItem): string {
  const lastMessage = item.kind === 'history-assistant-thread'
    ? getHistoryThreadLastMessage(item)
    : item.kind === 'history-message'
      ? item.message
      : null
  if (!lastMessage) return ''

  const inputTokens = getAssistantUsageValue(lastMessage, 'input_tokens')
  const outputTokens = getAssistantUsageValue(lastMessage, 'output_tokens')
  const cacheReadTokens = getAssistantUsageValue(lastMessage, 'cache_read_input_tokens')
  const cacheWriteTokens = getAssistantUsageValue(lastMessage, 'cache_creation_input_tokens')
  const model = getAssistantModelName(lastMessage)
  const stopReason = getAssistantStopReason(lastMessage)
  const executionDuration = item.kind === 'history-message' || item.kind === 'history-assistant-thread'
    ? formatDuration(item.executionDurationMs)
    : '-'

  return `${stopReason} • ${executionDuration} • ↑ ${formatCompactNumber(inputTokens)} ↓ ${formatCompactNumber(outputTokens)} • R ${formatCompactNumber(cacheReadTokens)} W ${formatCompactNumber(cacheWriteTokens)} • ${model}`
}

function getMessageRole(message: SessionMessage | null | undefined): SessionMessage['role'] | undefined {
  return message?.role
}

function renderMessageContent(message: SessionMessage): string {
  return message.content || ''
}

function getMessageClass(message: SessionMessage | null | undefined): string {
  return getMessageRole(message) === 'user'
    ? 'bg-blue-600 text-white'
    : getMessageRole(message) === 'system'
      ? 'bg-red-50 text-red-700 border border-red-200'
      : 'bg-white border border-gray-200 shadow-sm'
}

function isUserTimelineItem(item: TimelineItem): boolean {
  if (item.kind === 'history-user-message') return true
  if (item.kind === 'history-message' || item.kind === 'history-assistant-thread') return false
  return item.event.payload?.type === 'user'
}

function getMessageUuid(message: SessionMessage | null | undefined): string {
  const raw = message?.raw
  if (!raw || typeof raw !== 'object') return 'uuid=unknown'
  const value = (raw as Record<string, unknown>).uuid
  return typeof value === 'string' ? value : 'uuid=unknown'
}

function getMessageParentUuid(message: SessionMessage | null | undefined): string {
  const raw = message?.raw
  if (!raw || typeof raw !== 'object') return 'none'
  const value = (raw as Record<string, unknown>).parentUuid
  if (typeof value === 'string' && value) return value
  if (value === null) return 'null'
  return 'none'
}

function getMessageDebugMeta(message: SessionMessage | null | undefined): string {
  return `uuid=${getMessageUuid(message)} parent=${getMessageParentUuid(message)}`
}

function isRedactedThinkingMessage(message: SessionMessage): boolean {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return false

  const messageRecord = (raw as Record<string, unknown>).message
  if (!messageRecord || typeof messageRecord !== 'object') return false

  const content = (messageRecord as Record<string, unknown>).content
  if (Array.isArray(content)) {
    return content.length === 1
      && Boolean(content[0])
      && typeof content[0] === 'object'
      && (content[0] as Record<string, unknown>).type === 'redacted_thinking'
  }

  return Boolean(content && typeof content === 'object' && (content as Record<string, unknown>).type === 'redacted_thinking')
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
  () => [session.timeline.length, session.runStateEvents.length, session.observabilityEvents.length, session.pendingInteraction?.id],
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
      v-for="item in visibleTimelineItems"
      :key="item.key"
      class="flex"
      :class="isUserTimelineItem(item) ? 'justify-end' : 'justify-start'"
    >
      <div
        v-if="isHistoryThreadItem(item)"
        class="max-w-[75%] rounded-2xl px-4 py-3 bg-white border border-gray-200 shadow-sm"
      >
        <div class="mb-2 text-[11px] uppercase tracking-wide opacity-60">
          {{ getHistoryThreadType(item) }}
          <span>· {{ formatTimelineTimestamp(item.timestamp) }}</span>
        </div>
        <div
          v-for="(threadItem, threadIndex) in getHistoryThreadItems(item)"
          :key="threadItem.key"
          class="last:mb-0"
          :class="threadIndex === 0 ? '' : 'mt-3 border-t border-gray-100 pt-3'"
          :style="getThreadItemStyle(threadItem)"
        >
          <div class="mb-2 text-[10px] break-all text-gray-400">
            {{ getMessageDebugMeta(threadItem.message) }}
          </div>
          <div v-if="isRedactedThinkingMessage(threadItem.message)" class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
            redacted_thinking
          </div>
          <template v-else-if="hasRenderableBlocks(threadItem.message)">
            <div
              v-for="(block, blockIndex) in threadItem.message.blocks || []"
              :key="`${threadItem.key}-${blockIndex}`"
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
                <div
                  v-if="block.output"
                  class="markdown-body prose prose-sm mt-2 max-w-none text-gray-800"
                  v-html="renderMarkdown(renderToolResultOutput(block.output))"
                />
              </div>
              <div
                v-else-if="block.type === 'thinking'"
                class="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-purple-800"
              >
                <div class="font-medium">Thinking</div>
                <div
                  v-if="block.text"
                  class="markdown-body prose prose-sm mt-2 max-w-none text-purple-900"
                  v-html="renderMarkdown(block.text)"
                />
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
            v-else-if="getMessageRole(threadItem.message) === 'assistant'"
            class="markdown-body prose prose-sm max-w-none"
            v-html="renderMarkdown(renderMessageContent(threadItem.message))"
          />
          <div v-else class="whitespace-pre-wrap">{{ renderMessageContent(threadItem.message) }}</div>
        </div>
        <div class="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500">
          {{ getHistoryCardFooter(item) }}
        </div>
      </div>
      <div
        v-else
        class="max-w-[75%] rounded-2xl px-4 py-3"
        :class="getHistoryCardClass(item)"
      >
        <div class="mb-2 text-[11px] uppercase tracking-wide opacity-60">
          {{ getPayloadType(item) }}
          <span v-if="item.kind === 'sdk-message'">· seq={{ item.event.sequence }}</span>
          <span>· {{ formatTimelineTimestamp(item.timestamp) }}</span>
        </div>
        <div v-if="item.kind !== 'sdk-message'" class="mb-2 text-[10px] break-all text-gray-400">
          {{ getMessageDebugMeta(getTimelineMessage(item)) }}
        </div>
        <template v-if="getTimelineMessage(item) && isRedactedThinkingMessage(getTimelineMessage(item) as SessionMessage)">
          <div class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
            redacted_thinking
          </div>
        </template>
        <template v-else-if="hasRenderableBlocks(getTimelineMessage(item))">
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
              <div
                v-if="block.output"
                class="markdown-body prose prose-sm mt-2 max-w-none text-gray-800"
                v-html="renderMarkdown(renderToolResultOutput(block.output))"
              />
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
          v-else-if="getMessageRole(getTimelineMessage(item)) === 'assistant'"
          class="markdown-body prose prose-sm max-w-none"
          v-html="renderMarkdown(renderMessageContent(getTimelineMessage(item) as SessionMessage))"
        />
        <div v-else-if="getTimelineMessage(item)" class="whitespace-pre-wrap">{{ renderMessageContent(getTimelineMessage(item) as SessionMessage) }}</div>
        <div v-if="item.kind === 'history-message'" class="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500">
          {{ getHistoryCardFooter(item) }}
        </div>
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

    <div v-if="runStateItems.length > 0" class="space-y-2">
      <div class="text-xs font-medium uppercase tracking-wide text-emerald-500">Run state events</div>
      <div
        v-for="item in runStateItems"
        :key="item.key"
        class="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
      >
        <div class="font-medium">{{ getRunStateLabel(item.event.payload as Record<string, unknown> | undefined) }}</div>
        <div class="mt-1 text-[11px] text-emerald-700">{{ getEventMeta(item.event) }}</div>
        <div v-if="getRunStateSummary(item.event.payload as Record<string, unknown> | undefined)" class="mt-2 whitespace-pre-wrap text-xs text-emerald-900">
          {{ getRunStateSummary(item.event.payload as Record<string, unknown> | undefined) }}
        </div>
        <details class="mt-2">
          <summary class="cursor-pointer text-[11px] text-emerald-700">Raw payload</summary>
          <pre class="mt-2 whitespace-pre-wrap text-xs text-emerald-950">{{ getEventPayload(item.event) }}</pre>
        </details>
      </div>
    </div>

    <div v-if="observabilityItems.length > 0" class="space-y-2">
      <div class="text-xs font-medium uppercase tracking-wide text-gray-400">Observability events</div>
      <div
        v-for="item in observabilityItems"
        :key="`telemetry-${item.sequence}`"
        class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
      >
        <div class="font-medium text-gray-900">{{ renderObservabilityTitle(item.payload as Record<string, unknown> | undefined) }}</div>
        <div class="mt-1 text-[11px] text-gray-500">{{ getEventMeta(item) }}</div>
        <pre class="mt-2 whitespace-pre-wrap">{{ getEventPayload(item) }}</pre>
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

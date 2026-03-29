<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { marked } from 'marked'
import { useChatStore, type ChatContentBlock } from '../stores/chat'

const chat = useChatStore()
const container = ref<HTMLElement>()

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!value) return ''

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function hasBlocks(blocks?: ChatContentBlock[]): boolean {
  return Array.isArray(blocks) && blocks.length > 0
}

// Auto-scroll to bottom
watch(
  () => [chat.messages.length, chat.streamingContent, chat.streamingBlocks.length],
  async () => {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  },
  { deep: true }
)
</script>

<template>
  <div ref="container" class="flex-1 overflow-y-auto p-6 space-y-4">
    <!-- Welcome -->
    <div
      v-if="chat.messages.length === 0 && !chat.streamingContent && chat.streamingBlocks.length === 0"
      class="flex items-center justify-center h-full text-gray-400"
    >
      <div class="text-center">
        <p class="text-4xl mb-4">☕</p>
        <p class="text-lg">Start a conversation with Coffee Agent</p>
      </div>
    </div>

    <!-- Messages -->
    <div
      v-for="(msg, i) in chat.messages"
      :key="i"
      class="flex"
      :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
    >
      <div
        class="max-w-[75%] rounded-2xl px-4 py-3"
        :class="
          msg.role === 'user'
            ? 'bg-blue-600 text-white'
            : msg.role === 'system'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-white border border-gray-200 shadow-sm'
        "
      >
        <template v-if="msg.role === 'assistant' && hasBlocks(msg.blocks)">
          <div
            v-for="(block, blockIndex) in msg.blocks"
            :key="`${i}-${blockIndex}`"
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
              >{{ formatStructuredValue(block.input) }}</pre>
            </div>
            <div
              v-else-if="block.type === 'tool_result'"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              <div class="font-medium">Tool result</div>
              <pre
                v-if="block.output"
                class="mt-2 whitespace-pre-wrap text-xs text-gray-800"
              >{{ formatStructuredValue(block.output) }}</pre>
            </div>
          </div>
        </template>
        <div
          v-else-if="msg.role === 'assistant'"
          class="markdown-body prose prose-sm max-w-none"
          v-html="renderMarkdown(msg.content)"
        />
        <div v-else class="whitespace-pre-wrap">{{ msg.content }}</div>
      </div>
    </div>

    <!-- Streaming content -->
    <div v-if="chat.streamingContent || chat.streamingBlocks.length > 0" class="flex justify-start">
      <div class="max-w-[75%] rounded-2xl px-4 py-3 bg-white border border-gray-200 shadow-sm">
        <template v-if="chat.streamingBlocks.length > 0">
          <div
            v-for="(block, blockIndex) in chat.streamingBlocks"
            :key="`stream-${blockIndex}`"
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
              >{{ formatStructuredValue(block.input) }}</pre>
            </div>
            <div
              v-else-if="block.type === 'tool_result'"
              class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              <div class="font-medium">Tool result</div>
              <pre
                v-if="block.output"
                class="mt-2 whitespace-pre-wrap text-xs text-gray-800"
              >{{ formatStructuredValue(block.output) }}</pre>
            </div>
          </div>
        </template>
        <div
          v-else
          class="markdown-body prose prose-sm max-w-none"
          v-html="renderMarkdown(chat.streamingContent)"
        />
      </div>
    </div>

    <!-- Loading indicator -->
    <div v-if="chat.isLoading && !chat.streamingContent && chat.streamingBlocks.length === 0" class="flex justify-start">
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

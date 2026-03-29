<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore } from '../stores/chat'

const chat = useChatStore()
const input = ref('')

function send() {
  const text = input.value.trim()
  if (!text || chat.isLoading) return
  chat.sendMessage(text)
  input.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="p-4 bg-white">
    <div class="max-w-4xl mx-auto flex gap-3">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="!chat.isConnected"
        placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
        rows="1"
        class="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
      />
      <button
        @click="send"
        :disabled="!input.trim() || chat.isLoading || !chat.isConnected"
        class="px-5 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Send
      </button>
    </div>
    <div v-if="chat.authRequired && !chat.hasAuthToken" class="text-center text-xs text-amber-600 mt-2">
      Waiting for access token...
    </div>
    <div v-else-if="!chat.isConnected" class="text-center text-xs text-red-500 mt-2">
      Disconnected — reconnecting...
    </div>
  </div>
</template>

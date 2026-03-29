<script setup lang="ts">
import { useChatStore } from '../stores/chat'

const chat = useChatStore()
</script>

<template>
  <div class="flex flex-col">
    <button
      @click="chat.newChat()"
      class="m-3 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
    >
      + New Chat
    </button>

    <div class="px-2">
      <button
        v-for="session in chat.sessions"
        :key="session.id"
        @click="chat.selectSession(session.id)"
        class="w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors"
        :class="
          chat.currentSessionId === session.id
            ? 'bg-gray-700 text-white'
            : 'text-gray-300 hover:bg-gray-800'
        "
      >
        {{ session.title }}
      </button>
    </div>
  </div>
</template>

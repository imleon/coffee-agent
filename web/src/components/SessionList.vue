<script setup lang="ts">
import { useSessionStore } from '../stores/session'

const sessionStore = useSessionStore()
</script>

<template>
  <div class="flex flex-col">
    <button
      @click="sessionStore.newChat()"
      class="m-3 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
    >
      + New Chat
    </button>

    <div class="px-2">
      <button
        v-for="item in sessionStore.sessions"
        :key="item.id"
        @click="sessionStore.selectSession(item.id)"
        class="w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors"
        :class="
          sessionStore.currentSessionId === item.id
            ? 'bg-gray-700 text-white'
            : 'text-gray-300 hover:bg-gray-800'
        "
      >
        {{ item.title }}
      </button>
    </div>
  </div>
</template>

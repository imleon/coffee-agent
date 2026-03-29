<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionList from './components/SessionList.vue'
import MessageList from './components/MessageList.vue'
import InputBar from './components/InputBar.vue'
import { useChatStore } from './stores/chat'

const chat = useChatStore()
const tokenInput = ref(chat.authToken)

function submitToken() {
  chat.setAuthToken(tokenInput.value)
}

function clearToken() {
  tokenInput.value = ''
  chat.clearAuthToken()
}

onMounted(() => {
  chat.initialize()
})
</script>

<template>
  <div class="flex h-screen bg-gray-50">
    <template v-if="!chat.authChecked">
      <main class="flex-1 flex items-center justify-center text-sm text-gray-500">
        Checking server status...
      </main>
    </template>

    <template v-else-if="chat.authRequired && !chat.hasAuthToken">
      <main class="flex-1 flex items-center justify-center p-6">
        <div class="w-full max-w-md rounded-2xl bg-white border border-gray-200 shadow-sm p-6">
          <h1 class="text-xl font-semibold text-gray-900">Coffee Agent</h1>
          <p class="mt-2 text-sm text-gray-600">请输入访问令牌以连接生产环境。</p>
          <input
            v-model="tokenInput"
            type="password"
            placeholder="Access token"
            class="mt-4 w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            @keydown.enter.prevent="submitToken"
          />
          <button
            class="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            @click="submitToken"
          >
            Connect
          </button>
          <p v-if="chat.authError" class="mt-3 text-sm text-red-600">{{ chat.authError }}</p>
        </div>
      </main>
    </template>

    <template v-else>
      <!-- Sidebar -->
      <aside class="w-64 bg-gray-900 text-white flex flex-col">
        <div class="p-4 border-b border-gray-700">
          <div class="flex items-center justify-between gap-2">
            <h1 class="text-lg font-bold">☕ Coffee Agent</h1>
            <button
              v-if="chat.authRequired"
              class="text-xs text-gray-300 hover:text-white"
              @click="clearToken"
            >
              退出
            </button>
          </div>
          <p v-if="chat.authError" class="mt-2 text-xs text-red-300">{{ chat.authError }}</p>
        </div>
        <SessionList class="flex-1 overflow-y-auto" />
      </aside>

      <!-- Main chat area -->
      <main class="flex-1 flex flex-col">
        <MessageList class="flex-1 overflow-y-auto" />
        <InputBar class="border-t border-gray-200" />
      </main>
    </template>
  </div>
</template>

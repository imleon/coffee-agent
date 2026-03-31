<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionList from './components/SessionList.vue'
import MessageList from './components/MessageList.vue'
import InputBar from './components/InputBar.vue'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const tokenInput = ref(session.authToken)

function submitToken() {
  session.setAuthToken(tokenInput.value)
}

function clearToken() {
  tokenInput.value = ''
  session.clearAuthToken()
}

onMounted(() => {
  session.initialize()
})
</script>

<template>
  <div class="flex h-screen bg-gray-50">
    <template v-if="!session.authChecked">
      <main class="flex-1 flex items-center justify-center text-sm text-gray-500">
        Checking server status...
      </main>
    </template>

    <template v-else-if="session.authRequired && !session.hasAuthToken">
      <main class="flex-1 flex items-center justify-center p-6">
        <div class="w-full max-w-md rounded-2xl bg-white border border-gray-200 shadow-sm p-6">
          <h1 class="text-xl font-semibold text-gray-900">Cotta</h1>
          <p class="mt-2 text-sm text-gray-600">请输入访问令牌以连接运行时。</p>
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
          <p v-if="session.authError" class="mt-3 text-sm text-red-600">{{ session.authError }}</p>
        </div>
      </main>
    </template>

    <template v-else>
      <aside class="w-64 bg-gray-900 text-white flex flex-col">
        <div class="p-4 border-b border-gray-700">
          <div class="flex items-center justify-between gap-2">
            <h1 class="text-lg font-bold">Cotta</h1>
            <button
              v-if="session.authRequired"
              class="text-xs text-gray-300 hover:text-white"
              @click="clearToken"
            >
              退出
            </button>
          </div>
          <p class="mt-2 text-xs text-gray-400">Run state: {{ session.runState }}</p>
          <p class="mt-1 text-xs text-gray-400">SDK events: {{ session.eventLog.length }}</p>
          <p v-if="session.authError" class="mt-2 text-xs text-red-300">{{ session.authError }}</p>
        </div>
        <SessionList class="flex-1 overflow-y-auto" />
      </aside>

      <main class="flex-1 flex flex-col">
        <MessageList class="flex-1 overflow-y-auto" />
        <InputBar class="border-t border-gray-200" />
      </main>
    </template>
  </div>
</template>

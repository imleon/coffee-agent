<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SessionList from './components/SessionList.vue'
import MessageList from './components/MessageList.vue'
import InputBar from './components/InputBar.vue'
import TransportLogView from './components/TransportLogView.vue'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const tokenInput = ref(session.authToken)
const activeView = ref<'session' | 'log'>('session')

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
  <div class="h-screen bg-gray-50">
    <template v-if="!session.authChecked">
      <main class="h-full flex items-center justify-center text-sm text-gray-500">
        Checking server status...
      </main>
    </template>

    <template v-else-if="session.authRequired && !session.hasAuthToken">
      <main class="h-full flex items-center justify-center p-6">
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
      <div class="flex h-full flex-col">
        <header class="border-b border-gray-200 bg-white">
          <div class="flex items-center justify-between gap-4 px-6 py-4">
            <div class="flex items-center gap-6">
              <h1 class="text-lg font-bold text-gray-900">Cotta</h1>
              <div class="flex items-center gap-2 rounded-xl bg-gray-100 p-1">
                <button
                  class="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'session' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'"
                  @click="activeView = 'session'"
                >
                  Session
                </button>
                <button
                  class="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                  :class="activeView === 'log' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'"
                  @click="activeView = 'log'"
                >
                  Log
                </button>
              </div>
            </div>

            <div class="flex items-center gap-4 text-xs text-gray-500">
              <div>Run state: {{ session.runState }}</div>
              <div>SDK events: {{ session.eventLog.length }}</div>
              <p v-if="session.authError" class="text-red-500">{{ session.authError }}</p>
              <button
                v-if="session.authRequired"
                class="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                @click="clearToken"
              >
                退出
              </button>
            </div>
          </div>
        </header>

        <main class="flex-1 min-h-0">
          <div v-if="activeView === 'session'" class="flex h-full">
            <aside class="w-64 bg-gray-900 text-white flex flex-col">
              <SessionList class="flex-1 overflow-y-auto" />
            </aside>

            <section class="flex-1 flex flex-col min-w-0">
              <MessageList class="flex-1 overflow-y-auto" />
              <InputBar class="border-t border-gray-200" />
            </section>
          </div>

          <div v-else class="h-full">
            <TransportLogView class="h-full" />
          </div>
        </main>
      </div>
    </template>
  </div>
</template>

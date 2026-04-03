<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../stores/session'
import type { PendingPermissionInteraction, PermissionSuggestion } from '../../../shared/message-types.js'

const props = defineProps<{
  interaction: PendingPermissionInteraction
}>()

const session = useSessionStore()
const selectedPermissionSuggestionAction = ref('')
const submittedDecision = ref<'approve' | 'deny' | null>(null)

const title = computed(() => props.interaction.title || props.interaction.displayName || props.interaction.toolName || 'Pending interaction')
const description = computed(() => props.interaction.description || '')
const reason = computed(() => props.interaction.decisionReason || '')
const suggestions = computed(() => props.interaction.permissionSuggestions || [])
const isSubmitted = computed(() => submittedDecision.value !== null)

const selectedSuggestion = computed<PermissionSuggestion | null>(() => {
  if (suggestions.value.length === 0) return null
  return suggestions.value.find((suggestion) => suggestion.action === selectedPermissionSuggestionAction.value) || suggestions.value[0] || null
})

function getDefaultPermissionSuggestionAction(nextSuggestions: PermissionSuggestion[]): string {
  if (nextSuggestions.length === 0) return ''
  return nextSuggestions.find((suggestion) => suggestion.scope === 'session')?.action
    || nextSuggestions.find((suggestion) => suggestion.action === 'allow')?.action
    || nextSuggestions[0]?.action
    || ''
}

function submitPermission(decision: 'approve' | 'deny') {
  submittedDecision.value = decision
  session.respondToPermission(decision, decision === 'approve' ? selectedSuggestion.value || undefined : undefined)
}

watch(
  () => props.interaction.id,
  () => {
    selectedPermissionSuggestionAction.value = getDefaultPermissionSuggestionAction(suggestions.value)
    submittedDecision.value = null
  },
  { immediate: true },
)
</script>

<template>
  <div class="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-slate-700">
      <span class="font-medium text-amber-900">Permission required</span>
      <span class="text-slate-400">·</span>
      <span class="text-slate-600">{{ title }}</span>
    </div>

    <div v-if="description" class="mt-1 text-[12px] leading-5 text-slate-600">
      {{ description }}
    </div>
    <div v-if="reason" class="mt-1 text-[12px] leading-5 text-slate-500">
      {{ reason }}
    </div>

    <div v-if="suggestions.length" class="mt-3 space-y-2">
      <div class="text-[11px] uppercase tracking-wide text-slate-400">
        Permission scope
      </div>
      <label
        v-for="suggestion in suggestions"
        :key="`${interaction.id}-${suggestion.action}-${suggestion.scope || 'default'}`"
        class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
        :class="selectedPermissionSuggestionAction === suggestion.action
          ? 'border-amber-300 bg-white/90 text-slate-700'
          : 'border-amber-100/80 bg-white/65 text-slate-500 hover:border-amber-200 hover:bg-white/80'"
      >
        <input
          v-model="selectedPermissionSuggestionAction"
          type="radio"
          name="permission-suggestion"
          class="mt-1"
          :value="suggestion.action"
          :disabled="isSubmitted"
        >
        <span class="min-w-0 flex-1">
          <span class="block text-slate-700">{{ suggestion.label || suggestion.action }}</span>
          <span v-if="suggestion.description || suggestion.scope" class="block text-[11px] text-slate-500">
            {{ suggestion.description || suggestion.scope }}
          </span>
        </span>
      </label>
    </div>

    <div class="mt-3 flex flex-wrap gap-2 text-[12px]">
      <button
        class="rounded-md border px-2.5 py-1.5 transition-colors"
        :class="submittedDecision === 'approve'
          ? 'border-sky-300 bg-sky-600 text-white'
          : isSubmitted
            ? 'border-slate-200 bg-white/70 text-slate-400'
            : 'border-sky-200 bg-white text-slate-700 hover:border-sky-300 hover:text-sky-700'"
        :disabled="isSubmitted"
        @click="submitPermission('approve')"
      >
        {{ submittedDecision === 'approve' ? 'Allowed' : 'Allow' }}
      </button>
      <button
        class="rounded-md border px-2.5 py-1.5 transition-colors"
        :class="submittedDecision === 'deny'
          ? 'border-rose-300 bg-rose-600 text-white'
          : isSubmitted
            ? 'border-slate-200 bg-white/70 text-slate-400'
            : 'border-slate-200 bg-white text-slate-600 hover:border-rose-200 hover:text-rose-700'"
        :disabled="isSubmitted"
        @click="submitPermission('deny')"
      >
        {{ submittedDecision === 'deny' ? 'Denied' : 'Deny' }}
      </button>
    </div>
  </div>
</template>

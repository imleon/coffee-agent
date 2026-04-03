<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { DisplayFragmentSummary } from '../../../shared/message-types.js'

const props = defineProps<{
  fragment: DisplayFragmentSummary
}>()

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <TimelineCliSubrow muted>
    <div class="markdown-body prose prose-sm max-w-none text-slate-500" v-html="renderMarkdown(props.fragment.text)" />
  </TimelineCliSubrow>
</template>

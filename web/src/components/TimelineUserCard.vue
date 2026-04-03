<script setup lang="ts">
import type { UserDisplayItem } from '../../../shared/message-types.js'

defineProps<{
  item: UserDisplayItem
}>()
</script>

<template>
  <div class="whitespace-pre-wrap text-[15px] leading-7 text-slate-900">{{ item.message.content }}</div>
</template>

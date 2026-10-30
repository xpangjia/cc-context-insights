<script setup lang="ts">
defineProps<{ on?: boolean; size?: number }>();
</script>
<template>
  <svg :width="size ?? 14" :height="size ?? 14" viewBox="0 0 16 16" aria-hidden="true" class="pin-ic">
    <path d="M10.2 1.8 14.2 5.8 12.6 6.4 9.9 9.1 10.3 12.3 9 13.6 6.4 11 3 14.4 1.6 13 5 9.6 2.4 7 3.7 5.7 6.9 6.1 9.6 3.4Z"
      :fill="on ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
  </svg>
</template>
<style scoped>
.pin-ic { display: inline-block; vertical-align: -2px; flex: none; }
</style>

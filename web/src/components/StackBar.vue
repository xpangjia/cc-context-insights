<script setup lang="ts">
/** 横向堆叠条:各类占窗口的比例,剩下的是空闲 */
defineProps<{ segs: { key: string; label: string; value: number; color: string }[]; total: number; height?: number }>();
</script>
<template>
  <div class="bar" :style="{ height: (height ?? 14) + 'px' }">
    <i v-for="s in segs.filter(x => x.value > 0)" :key="s.key" :style="{ width: (s.value / total) * 100 + '%', background: s.color }" :title="`${s.label} ${((s.value / total) * 100).toFixed(1)}%`"></i>
  </div>
</template>
<style scoped>
.bar { display: flex; gap: 2px; background: var(--c-free); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; min-width: 2px; }
</style>

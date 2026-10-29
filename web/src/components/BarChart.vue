<script setup lang="ts">
/** 单序列柱状图:一种颜色,悬停看数值,最后一根(今天)高亮;不需要图例,标题说明是什么 */
import { computed } from "vue";
const props = defineProps<{ data: { label: string; value: number; tip: string }[]; height?: number; every?: number }>();
const max = computed(() => Math.max(1, ...props.data.map(d => d.value)));
const every = computed(() => props.every ?? (props.data.length > 14 ? 5 : 1));
</script>
<template>
  <div class="chart" :style="{ height: (height ?? 120) + 'px' }" role="img" :aria-label="data.map(d => d.tip).join('；')">
    <div v-for="(d, i) in data" :key="i" class="b" :class="{ hi: i === data.length - 1 }">
      <i :style="{ height: d.value ? Math.max(2, (d.value / max) * 100) + '%' : '0' }"></i>
      <span class="tip">{{ d.tip }}</span>
    </div>
  </div>
  <div class="xl" :style="{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }">
    <span v-for="(d, i) in data" :key="i">{{ i === data.length - 1 || (data.length - 1 - i) % every === 0 ? d.label : "" }}</span>
  </div>
</template>
<style scoped>
.chart { display: flex; gap: 3px; align-items: flex-end; border-bottom: 1px solid var(--line); }
.b { position: relative; flex: 1; height: 100%; display: flex; align-items: flex-end; }
.b i { display: block; width: 100%; border-radius: 3px 3px 0 0; background: var(--bar); }
.b.hi i { background: var(--bar-hi); }
.b:hover i { filter: brightness(.9); }
.b::after { content: ""; position: absolute; inset: 0 -2px; } /* 加大悬停区域 */
.tip { display: none; position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--card); font-size: 11px; padding: 3px 8px; border-radius: 5px; white-space: nowrap; z-index: 5; pointer-events: none; }
.b:hover .tip { display: block; }
.xl { display: grid; gap: 3px; margin-top: 5px; font: 11px var(--num); color: var(--ink3); text-align: center; white-space: nowrap; }
</style>

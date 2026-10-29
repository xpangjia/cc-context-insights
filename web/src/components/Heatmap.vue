<script setup lang="ts">
/** 活跃热力图:最近 8 周,每格一天,颜色越深用得越多(单色深浅,悬停看数) */
import { computed } from "vue";
const props = defineProps<{ data: { day: string; value: number; label?: string }[] }>();
const emit = defineEmits<{ pick: [day: string] }>();
const map = computed(() => new Map(props.data.map(d => [d.day, d])));
const max = computed(() => Math.max(1, ...props.data.map(d => d.value)));
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 8 列(周)× 7 行(周一到周日),最后一列是本周 */
const weeks = computed(() => {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 周一=0
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7 * 7);
  return Array.from({ length: 8 }, (_, w) => Array.from({ length: 7 }, (_, d) => {
    const t = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
    const key = ymd(t);
    return { key, future: t > now, v: map.value.get(key)?.value ?? 0, label: map.value.get(key)?.label };
  }));
});
const level = (v: number) => (v <= 0 ? 0 : Math.min(4, Math.ceil((v / max.value) * 4)));
const months = computed(() => weeks.value.map((w, i) => { const m = Number(w[0].key.slice(5, 7)); return i === 0 || m !== Number(weeks.value[i - 1][0].key.slice(5, 7)) ? `${m} 月` : ""; }));
</script>
<template>
  <div class="hm">
    <div class="mrow"><span></span><span v-for="(m, i) in months" :key="i">{{ m }}</span></div>
    <div class="body">
      <div class="days"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
      <div class="cols">
        <div v-for="(w, i) in weeks" :key="i" class="col">
          <i v-for="c in w" :key="c.key" :class="['l' + level(c.v), { future: c.future }]" :title="c.future ? '' : `${c.key} · ${c.label ?? c.v}`" @click="!c.future && c.v && emit('pick', c.key)"></i>
        </div>
      </div>
    </div>
    <div class="lg"><span>少</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>多</span></div>
  </div>
</template>
<style scoped>
.hm { font-size: 11px; color: var(--ink3); }
.mrow { display: grid; grid-template-columns: 18px repeat(8, 1fr); gap: 4px; margin-bottom: 4px; }
.body { display: grid; grid-template-columns: 18px 1fr; gap: 4px; }
.days { display: grid; grid-template-rows: repeat(7, 1fr); gap: 4px; }
.cols { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.col { display: grid; grid-template-rows: repeat(7, 1fr); gap: 4px; }
i { display: block; aspect-ratio: 1; border-radius: 3px; background: var(--cell-empty); cursor: pointer; }
i.l1 { background: #b7d3f6; } i.l2 { background: #6da7ec; } i.l3 { background: #2a78d6; } i.l4 { background: #184f95; }
i.future { visibility: hidden; }
.lg { display: flex; gap: 3px; align-items: center; justify-content: flex-end; margin-top: 8px; }
.lg i { width: 11px; height: 11px; cursor: default; }
@media (prefers-color-scheme: dark) { i.l1 { background: #184f95; } i.l2 { background: #256abf; } i.l3 { background: #3987e5; } i.l4 { background: #86b6ef; } }
</style>

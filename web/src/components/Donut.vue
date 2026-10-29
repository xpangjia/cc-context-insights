<script setup lang="ts">
/** 环形图 + 图例:每一段都有文字、百分比和数值(不只靠颜色) */
import { computed, ref } from "vue";
type Seg = { key: string; label: string; value: number; color: string; sub?: string };
const props = defineProps<{ segs: Seg[]; center: string; centerSub?: string; size?: number; cols?: number; bare?: boolean }>();
const hover = ref<string | null>(null);
const total = computed(() => props.segs.reduce((s, x) => s + x.value, 0) || 1);
const R = 42, C = 2 * Math.PI * R;
/** 中间的字按环的大小和字数缩放,不压到圆环上 */
const centerSize = computed(() => { const sz = props.size ?? 120; const len = [...props.center].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.6 : 1), 0); return Math.max(10, Math.min(17, (sz * 0.62) / Math.max(3, len))); });
const arcs = computed(() => {
  let acc = 0;
  return props.segs.filter(s => s.value > 0).map(s => {
    const len = (s.value / total.value) * C;
    const gap = Math.min(1.5, len / 3); // 段与段之间留一条底色缝
    const a = { ...s, dash: `${Math.max(0, len - gap)} ${C}`, offset: -acc };
    acc += len;
    return a;
  });
});
const p = (v: number) => { const x = v / total.value; return x > 0 && x < 0.001 ? "<0.1%" : `${(x * 100).toFixed(1)}%`; };
</script>
<template>
  <div class="donut">
    <div class="ring" :style="{ width: (size ?? 120) + 'px', height: (size ?? 120) + 'px' }">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" :r="R" fill="none" stroke="var(--c-free)" stroke-width="11" />
        <circle v-for="a in arcs" :key="a.key" cx="50" cy="50" :r="R" fill="none" :stroke="a.color" stroke-width="11"
          :stroke-dasharray="a.dash" :stroke-dashoffset="a.offset" transform="rotate(-90 50 50)"
          :opacity="hover && hover !== a.key ? 0.35 : 1" @mouseenter="hover = a.key" @mouseleave="hover = null">
          <title>{{ a.label }} {{ p(a.value) }}</title>
        </circle>
      </svg>
      <div class="center"><b :style="{ fontSize: centerSize + 'px' }">{{ center }}</b><span v-if="centerSub">{{ centerSub }}</span></div>
    </div>
    <div v-if="!bare" class="legend" :style="{ gridTemplateColumns: `repeat(${cols ?? 2}, minmax(0, 1fr))` }">
      <div v-for="s in segs" :key="s.key" class="li" :class="{ dim: hover && hover !== s.key }" @mouseenter="hover = s.key" @mouseleave="hover = null">
        <i :style="{ background: s.color }"></i>
        <div class="lt"><span class="nm">{{ s.label }}</span><span class="sb">{{ s.sub }}</span></div>
        <span class="pc">{{ p(s.value) }}</span>
      </div>
    </div>
  </div>
</template>
<style scoped>
.donut { display: flex; gap: 22px; align-items: center; }
.ring { position: relative; flex: none; }
.ring svg { width: 100%; height: 100%; }
.ring circle { transition: opacity .15s; cursor: default; }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.center b { font: 600 17px var(--num); }
.center span { font-size: 11px; color: var(--ink3); }
.legend { display: grid; gap: 8px 18px; flex: 1; min-width: 0; }
.li { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; gap: 7px; align-items: start; transition: opacity .15s; }
.li.dim { opacity: .4; }
.li i { width: 9px; height: 9px; border-radius: 2px; margin-top: 5px; }
.lt { display: flex; flex-direction: column; min-width: 0; }
.nm { font-size: 13px; font-weight: 500; }
.sb { font-size: 11.5px; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc { font: 600 13px var(--num); }
@media (max-width: 700px) { .donut { flex-direction: column; align-items: stretch; } .ring { align-self: center; } }
</style>

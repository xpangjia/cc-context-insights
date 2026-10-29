<script setup lang="ts">
/**
 * 上下文趋势:每次请求一根堆叠柱(七类),压缩处打标记
 * 全量 = 这次请求带了多少;增量 = 比上一次多了/少了多少(多的往上长,少的往下伸)
 */
import { computed, ref, watch, nextTick } from "vue";
import { CATS, CAT_CN, color, tk } from "../lib/ctx";

type Pt = { idx: number; at: string; cats: Record<string, number>; total: number; output: number; modelMs: number };
const props = defineProps<{ data: Pt[]; marks?: { req: number; text: string }[]; selected?: number | null; mode: "total" | "delta"; fit: boolean }>();
const emit = defineEmits<{ select: [idx: number] }>();
const hoverIdx = ref<number | null>(null);
const box = ref<HTMLElement>();
const H = 180;

const deltas = computed(() => props.data.map((p, i) => {
  const prev = props.data[i - 1];
  return Object.fromEntries(CATS.map(c => [c, p.cats[c] - (prev?.cats[c] ?? 0)])) as Record<string, number>;
}));
const maxTotal = computed(() => Math.max(1, ...props.data.map(p => CATS.reduce((s, c) => s + p.cats[c], 0))));
const maxUp = computed(() => Math.max(1, ...deltas.value.map(d => CATS.reduce((s, c) => s + Math.max(0, d[c]), 0))));
const maxDown = computed(() => Math.max(0, ...deltas.value.map(d => CATS.reduce((s, c) => s + Math.max(0, -d[c]), 0))));
/** 增量模式:基线位置按上下最大值的比例分 */
const baseline = computed(() => (props.mode === "delta" ? H * (maxUp.value / (maxUp.value + maxDown.value || 1)) : H));
const colW = computed(() => (props.fit ? null : Math.max(4, Math.min(22, 900 / Math.max(1, props.data.length)))));
const markSet = computed(() => new Map((props.marks ?? []).map(m => [m.req, m.text])));

function segs(i: number) {
  const out: { c: string; top: number; h: number }[] = [];
  if (props.mode === "total") {
    let y = H;
    for (const c of CATS) { const h = (props.data[i].cats[c] / maxTotal.value) * H; y -= h; out.push({ c, top: y, h }); }
  } else {
    const scale = baseline.value / maxUp.value;
    let up = baseline.value, down = baseline.value;
    for (const c of CATS) {
      const v = deltas.value[i][c];
      if (v > 0) { const h = v * scale; up -= h; out.push({ c, top: up, h }); }
      else if (v < 0) { const h = -v * scale; out.push({ c, top: down, h }); down += h; }
    }
  }
  return out.filter(s => s.h > 0.2);
}
const ticks = computed(() => props.mode === "total" ? [1, 0.75, 0.5, 0.25].map(f => ({ y: H - f * H, label: tk(maxTotal.value * f) })) : [{ y: baseline.value, label: "0" }]);
const tip = computed(() => {
  const i = hoverIdx.value ?? props.selected;
  if (i == null || !props.data[i]) return null;
  const p = props.data[i];
  const rows = CATS.map(c => ({ c, v: props.mode === "total" ? p.cats[c] : deltas.value[i][c] })).filter(r => r.v !== 0);
  return { p, i, rows };
});
watch(() => [props.data.length, props.fit], async () => { await nextTick(); if (box.value && !props.fit) box.value.scrollLeft = box.value.scrollWidth; }, { immediate: true });
</script>

<template>
  <div class="trend">
    <div class="axis"><span v-for="t in ticks" :key="t.y" :style="{ top: t.y - 7 + 'px' }">{{ t.label }}</span></div>
    <div ref="box" class="plot" :class="{ fit }">
      <div class="cols" :style="{ height: H + 'px', width: fit ? '100%' : data.length * ((colW ?? 6) + 2) + 'px' }">
        <div v-for="t in ticks" :key="'g' + t.y" class="grid" :style="{ top: t.y + 'px' }"></div>
        <div v-for="(p, i) in data" :key="p.idx" class="col" :class="{ sel: selected === i, hov: hoverIdx === i }"
          :style="fit ? {} : { width: colW + 'px' }" @mouseenter="hoverIdx = i" @mouseleave="hoverIdx = null" @click="emit('select', i)">
          <i v-for="s in segs(i)" :key="s.c" :style="{ top: s.top + 'px', height: s.h + 'px', background: color(s.c) }"></i>
          <b v-if="markSet.has(i)" class="mark" :title="markSet.get(i)">✂</b>
        </div>
      </div>
    </div>
    <div class="tip" v-if="tip">
      <div class="th"><b>第 {{ tip.i + 1 }} 次请求</b><span>{{ tip.p.at.slice(5, 16) }}</span><span v-if="mode === 'total'">共 {{ tk(tip.p.total) }}</span><span>输出 {{ tk(tip.p.output) }}</span></div>
      <div class="tr">
        <span v-for="r in tip.rows" :key="r.c"><i :style="{ background: color(r.c) }"></i>{{ CAT_CN[r.c] }} <b :class="{ neg: r.v < 0 }">{{ mode === "delta" && r.v > 0 ? "+" : "" }}{{ r.v < 0 ? "-" + tk(-r.v) : tk(r.v) }}</b></span>
      </div>
      <div v-if="markSet.has(tip.i)" class="tm">✂ {{ markSet.get(tip.i) }}</div>
    </div>
  </div>
</template>

<style scoped>
.trend { position: relative; display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 6px; }
.axis { position: relative; height: 180px; font: 11px var(--num); color: var(--ink3); text-align: right; }
.axis span { position: absolute; right: 0; }
.plot { overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
.cols { position: relative; display: flex; gap: 2px; align-items: stretch; }
.plot.fit .cols { gap: 0; }
.plot.fit .col { flex: 1; min-width: 0; }
.grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--line2); pointer-events: none; }
.col { position: relative; flex: none; cursor: pointer; }
.col i { position: absolute; left: 0; right: 0; display: block; }
.col.hov, .col.sel { background: var(--hover); }
.col.sel { outline: 1.5px solid var(--ink3); outline-offset: -1px; }
.mark { position: absolute; top: -2px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--bad); font-weight: 400; }
.tip { grid-column: 2; margin-top: 8px; font-size: 12px; color: var(--ink2); min-height: 40px; }
.th { display: flex; gap: 12px; flex-wrap: wrap; }
.th b { color: var(--ink); }
.tr { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; }
.tr i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.tr b { font: 600 12px var(--num); color: var(--ink); }
.tr b.neg { color: var(--bad); }
.tm { color: var(--bad); margin-top: 2px; }
</style>

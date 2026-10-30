<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import Donut from "../components/Donut.vue";
import BarChart from "../components/BarChart.vue";
import Heatmap from "../components/Heatmap.vue";
import { get } from "../lib/api";
import { embedded } from "../lib/embed";
import SessionSearch from "../components/SessionSearch.vue";
import { CATS, CAT_CN, color, tk, pct, usd, dms, ago, shown } from "../lib/ctx";

const route = useRoute(), router = useRouter();
const d = ref<any>(null), loading = ref(false);
const range = ref((route.query.range as string) || "30d");
const limit = ref(24);
const q = ref(""), sort = ref<"recent" | "billed" | "ctx">("recent"), where = ref(""), heatBy = ref<"billed" | "sessions">("billed");
const RANGES = [{ k: "today", t: "今天" }, { k: "7d", t: "近 7 天" }, { k: "30d", t: "近 30 天" }, { k: "all", t: "全部" }];

async function load() {
  loading.value = true;
  d.value = await get(`/api/insights?range=${range.value}&q=${encodeURIComponent(q.value)}`);
  loading.value = false;
}
watch(range, v => { router.replace({ query: { ...route.query, range: v } }); load(); });
let t: number; watch(q, () => { clearTimeout(t); t = window.setTimeout(load, 300); });
onMounted(load);

const compSegs = computed(() => {
  if (!d.value) return [];
  const c = d.value.composition;
  return [...shown(k => c[k] > 0).map(k => ({ key: k, label: CAT_CN[k], value: c[k], color: color(k), sub: k === "base" ? `约 ${tk(c[k])} · 日志里没有，推算的合计` : `约 ${tk(c[k])}` })),
    { key: "output", label: "输出", value: c.output, color: color("output"), sub: tk(c.output) }];
});
const splitTotal = computed(() => d.value ? CATS.reduce((s, k) => s + d.value.composition[k], 0) + d.value.composition.output : 0);
const unsplitShare = computed(() => d.value ? d.value.composition.unsplit / (d.value.composition.unsplit + splitTotal.value || 1) : 0);
const timeSegs = computed(() => d.value ? [
  { key: "model", label: "模型调用", value: d.value.timing.modelMs, color: color("system"), sub: `${dms(d.value.timing.modelMs)} · ${d.value.timing.calls} 次` },
  { key: "tool", label: "工具执行", value: d.value.timing.toolMs, color: color("user"), sub: `${dms(d.value.timing.toolMs)} · ${d.value.timing.tools} 次` },
] : []);
const weekData = computed(() => (d.value?.week ?? []).map((w: any, i: number, a: any[]) => ({
  label: i === a.length - 1 ? "今天" : `${Number(w.day.slice(5, 7))}/${Number(w.day.slice(8))}`, value: w.billed,
  tip: `${w.day.slice(5)} · ${tk(w.billed)} token · 约 ${usd(w.cost)}`,
})));
const heat = computed(() => (d.value?.heat ?? []).map((h: any) => ({ day: h.day, value: heatBy.value === "billed" ? h.billed : h.sessions, label: heatBy.value === "billed" ? `${tk(h.billed)} token` : `${h.sessions} 个会话` })));
const wheres = computed(() => { const m = new Map<string, number>(); for (const c of d.value?.cards ?? []) m.set(c.where, (m.get(c.where) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); });
const cards = computed(() => (d.value?.cards ?? []).filter((c: any) => !where.value || c.where === where.value)
  .sort((a: any, b: any) => sort.value === "billed" ? b.billed - a.billed : sort.value === "ctx" ? b.ctx - a.ctx : b.lastAt.localeCompare(a.lastAt)));
type Seg = { key: string; label: string; value: number; color: string };
const miniSegs = (c: any): Seg[] => c.cats ? [...CATS.map(k => ({ key: k as string, label: CAT_CN[k], value: c.cats[k] as number, color: color(k) })), { key: "free", label: "空闲", value: Math.max(0, 1_000_000 - c.ctx), color: "transparent" }] : [];
</script>

<template>
  <div class="pagehead"><h1>上下文洞察</h1><span class="muted">所有 Claude Code 会话的用量、上下文组成和耗时</span><SessionSearch v-if="embedded" /></div>
  <div class="rangebar">
    <div class="seg"><button v-for="r in RANGES" :key="r.k" :class="{ on: range === r.k }" @click="range = r.k">{{ r.t }}</button></div>
    <span v-if="d" class="muted small">{{ d.from === "0000" ? "全部记录" : `${d.from} 起` }} · 费用按官方价估算，和你实际付的可能不同</span>
  </div>
  <template v-if="d">
    <div class="top">
      <div class="kpis">
        <div class="card kpi"><div class="l">会话</div><div class="v">{{ d.kpi.sessions }}</div><div class="s">模型调用 {{ d.kpi.calls.toLocaleString() }} 次</div></div>
        <div class="card kpi"><div class="l">Token 消耗</div><div class="v">{{ tk(d.kpi.billed) }}</div><div class="s">其中输出 {{ tk(d.kpi.output) }}</div></div>
        <div class="card kpi"><div class="l">估算费用</div><div class="v">{{ usd(d.kpi.cost) }}</div><div class="s">按 Anthropic 官方价</div></div>
        <div class="card kpi"><div class="l">缓存命中</div><div class="v">{{ pct(d.kpi.cacheHit) }}</div><div class="s">输入里从缓存读的比例</div></div>
        <div class="card kpi"><div class="l">工具调用</div><div class="v">{{ d.kpi.tools.toLocaleString() }}</div><div class="s">执行 {{ dms(d.kpi.toolMs) }}</div></div>
        <div class="card kpi"><div class="l">活跃时长</div><div class="v">{{ dms(d.kpi.activeMs) }}</div><div class="s">主控和子 Agent 累计</div></div>
      </div>
      <div class="card week">
        <h2 class="card-title">近 7 天用量<span class="more muted">7 天约 {{ usd(d.week.reduce((s: number, w: any) => s + w.cost, 0)) }}</span></h2>
        <BarChart :data="weekData" :height="150" :every="1" />
        <div class="note muted">柱高是计费 token，悬停看当天的估算费用</div>
      </div>
    </div>

    <div class="row2">
      <div class="card">
        <h2 class="card-title">Token 统计<span class="more muted">缓存命中 {{ pct(d.kpi.cacheHit) }}</span></h2>
        <Donut :segs="compSegs" :center="tk(splitTotal)" center-sub="能拆分的用量" :size="130" />
        <div v-if="unsplitShare > 0.01" class="note muted">另有 {{ tk(d.composition.unsplit) }}（占 {{ pct(unsplitShare, 0) }}）的请求在日志里找不到对应的对话内容，拆不开类别，没算进环里</div>
      </div>
      <div class="card">
        <h2 class="card-title">耗时统计<span class="more muted">输出速度 {{ Math.round(d.timing.speed) }} token/秒</span></h2>
        <Donut :segs="timeSegs" :center="dms(d.timing.modelMs + d.timing.toolMs)" center-sub="团队累计" :size="130" :cols="1" />
        <div class="note muted">单次调用最多按 30 分钟计（更长多半是电脑休眠或在等确认）；派子 Agent 的那次调用不计，子 Agent 自己的时间另算</div>
      </div>
    </div>

    <div class="row3">
      <div class="col">
        <div class="card">
          <h2 class="card-title">活跃度<div class="seg sm right"><button :class="{ on: heatBy === 'billed' }" @click="heatBy = 'billed'">Token</button><button :class="{ on: heatBy === 'sessions' }" @click="heatBy = 'sessions'">会话</button></div></h2>
          <Heatmap :data="heat" />
        </div>
        <div class="card">
          <h2 class="card-title">技能加载<span class="tag">{{ d.skills.reduce((s: number, x: any) => s + x.n, 0) }} 次</span></h2>
          <div v-for="s in d.skills" :key="s.skill" class="skill"><span class="mono">{{ s.skill }}</span><span>×{{ s.n }}</span><span class="muted">{{ ago(s.last) }}</span></div>
          <div v-if="!d.skills.length" class="empty">这段时间没加载技能</div>
        </div>
      </div>
      <div class="sessions">
        <div class="sbar">
          <b>会话</b><span class="tag">{{ cards.length }}</span>
          <input v-model="q" class="inp" placeholder="搜标题或最后一句…" />
          <select v-model="where" class="inp"><option value="">全部位置</option><option v-for="[w, n] in wheres" :key="w" :value="w">{{ w }}（{{ n }}）</option></select>
          <div class="seg sm"><button :class="{ on: sort === 'recent' }" @click="sort = 'recent'">最近</button><button :class="{ on: sort === 'billed' }" @click="sort = 'billed'">Token 总量</button><button :class="{ on: sort === 'ctx' }" @click="sort = 'ctx'">当前上下文</button></div>
        </div>
        <div class="cards">
          <RouterLink v-for="c in cards.slice(0, limit)" :key="c.id" :to="`/session?id=${c.id}&tab=context`" class="card sc">
            <div class="sh"><div class="st">{{ (c.title ?? "（没有输入）").replace(/\s+/g, " ") }}</div><div class="sa muted">{{ ago(c.lastAt) }}<br>{{ c.lastAt.slice(0, 10) }}</div></div>
            <div class="tags"><span class="tag">{{ c.where }}</span><span v-if="c.auto" class="tag">脚本自动</span><span v-if="c.subagents" class="tag">{{ c.subagents }} 个子 Agent</span></div>
            <div class="sb">
              <Donut v-if="c.cats" :segs="miniSegs(c)" :center="tk(c.ctx)" :center-sub="pct(c.ctxPct)" :size="74" bare />
              <div v-else class="noctx muted">旧版记录<br>拆不开</div>
              <div class="kv"><span>轮次 · 步数</span><b>{{ c.turns }} 轮 {{ c.steps }} 步</b><span>Token 总量</span><b>{{ tk(c.billed) }}</b><span>估算费用</span><b>{{ usd(c.cost) }}</b></div>
            </div>
            <div class="last"><span class="muted">最后一句</span> {{ (c.lastPrompt ?? "").replace(/\s+/g, " ") }}</div>
          </RouterLink>
        </div>
        <div v-if="cards.length > limit" class="moreline"><button class="btn sm" @click="limit += 24">再看 24 个</button><span class="muted small">共 {{ cards.length }} 个</span></div>
        <div v-if="!cards.length" class="card empty">这段时间没有会话</div>
      </div>
    </div>
  </template>
  <div v-else class="card empty">正在汇总…</div>
</template>

<style scoped>
.pagehead { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
.pagehead .ss { margin-left: auto; align-self: center; }
.pagehead h1 { margin: 0; font: 600 26px var(--font-head); }
.rangebar { display: flex; gap: 14px; align-items: center; margin: 0 0 16px; flex-wrap: wrap; }
.small { font-size: 12px; }
.seg { display: inline-flex; background: var(--side); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--ink2); padding: 5px 12px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.seg button.on { background: var(--card); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
.seg.sm button { padding: 3px 9px; font-size: 12px; }
.right { margin-left: auto; font-weight: 400; }
.top { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: var(--gap); margin-bottom: var(--gap); }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); }
.kpi { padding: 16px 18px; text-align: center; }
.kpi .l { color: var(--ink3); font-size: 12px; }
.kpi .v { font: 600 26px/1.3 var(--num); margin: 4px 0 2px; }
.kpi .s { color: var(--ink2); font-size: 12px; }
.note { font-size: 12px; margin-top: 12px; line-height: 1.6; }
.row2 { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: var(--gap); margin-bottom: var(--gap); }
.row3 { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: var(--gap); align-items: start; }
.col { display: flex; flex-direction: column; gap: var(--gap); }
.skill { display: grid; grid-template-columns: minmax(0, 1fr) auto 80px; gap: 8px; padding: 7px 0; border-top: 1px solid var(--line2); font-size: 13px; }
.skill:first-of-type { border-top: none; }
.skill .muted { text-align: right; font-size: 12px; }
.sbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.inp { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 9px; padding: 5px 10px; font: 13px var(--font); outline: none; }
.sbar input.inp { flex: 1; min-width: 160px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); }
.sc { display: flex; flex-direction: column; gap: 8px; padding: 16px 18px; transition: border-color .15s; min-width: 0; }
.sc:hover { border-color: var(--acc); }
.sh { display: flex; gap: 10px; justify-content: space-between; }
.st { font-weight: 600; font-size: 14px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.5; }
.sa { font-size: 11.5px; text-align: right; white-space: nowrap; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; }
.sb { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 14px; align-items: center; }
.noctx { width: 74px; height: 74px; border-radius: 50%; border: 2px dashed var(--line); display: grid; place-items: center; text-align: center; font-size: 11px; line-height: 1.4; }
.kv { display: grid; grid-template-columns: auto auto; gap: 4px 10px; font-size: 12.5px; color: var(--ink2); }
.kv b { text-align: right; font: 600 12.5px var(--num); color: var(--ink); }
.moreline { display: flex; gap: 12px; align-items: center; justify-content: center; margin-top: 14px; }
.last { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink2); border-top: 1px solid var(--line2); padding-top: 8px; }
@media (max-width: 980px) { .top, .row2 { grid-template-columns: minmax(0, 1fr); } .row3 { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpi .v { font-size: 21px; } }
</style>

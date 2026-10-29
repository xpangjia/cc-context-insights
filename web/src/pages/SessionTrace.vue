<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { get } from "../lib/api";
import { dms } from "../lib/ctx";

const props = defineProps<{ id: string; agents: { id: string; title: string }[] }>();
const agent = ref("main");
const d = ref<any>(null);
const q = ref(""), kinds = ref<Record<string, boolean>>({ user: true, assistant: true, thinking: false, tool: true, agent: true, event: true });
const open = ref<Record<number, boolean>>({});
const KIND: Record<string, { t: string; c: string }> = {
  user: { t: "输入", c: "user" }, assistant: { t: "助手", c: "assistant" }, thinking: { t: "思考", c: "skill" },
  tool: { t: "工具", c: "tools" }, agent: { t: "通知", c: "inject" }, event: { t: "事件", c: "output" },
};
async function load() { d.value = await get(`/api/session/trace?id=${props.id}&agent=${agent.value}`); open.value = {}; }
watch(agent, load); onMounted(load);
const items = computed(() => (d.value?.items ?? []).map((x: any, i: number) => ({ ...x, i }))
  .filter((x: any) => kinds.value[x.kind] && (!q.value || `${x.text} ${x.detail ?? ""} ${x.name ?? ""}`.toLowerCase().includes(q.value.toLowerCase()))));
const count = (k: string) => (d.value?.items ?? []).filter((x: any) => x.kind === k).length;
/** 顶部时间带:把整个会话的时间压到一条线上,模型(蓝)、工具(青)、输入(绿)各一行 */
const span = computed(() => {
  if (!d.value?.start || !d.value?.end) return null;
  const a = Date.parse(d.value.start.replace(" ", "T")), b = Date.parse(d.value.end.replace(" ", "T"));
  return { a, len: Math.max(1, b - a) };
});
const bandRows = computed(() => {
  if (!span.value) return [];
  const pos = (t: string) => ((Date.parse(t.replace(" ", "T")) - span.value!.a) / span.value!.len) * 100;
  return ["user", "model", "tool"].map(k => ({ k, bars: (d.value.bands as any[]).filter(b => b.kind === k && b.at).map(b => {
    const l = pos(b.at), r = b.end ? pos(b.end) : l;
    return { left: l, width: Math.max(0.15, r - l) };
  }) }));
});
const BAND = { user: ["输入", "var(--c-user)"], model: ["模型", "var(--c-system)"], tool: ["工具", "var(--c-tools)"] } as Record<string, [string, string]>;
</script>

<template>
  <div v-if="!d" class="card empty">正在整理轨迹…</div>
  <template v-else>
    <div class="card">
      <div class="bar">
        <div v-if="agents.length > 1" class="seg sm"><button v-for="a in agents" :key="a.id" :class="{ on: agent === a.id }" @click="agent = a.id">{{ a.title }}</button></div>
        <div class="kinds"><label v-for="(v, k) in KIND" :key="k" class="kd"><input type="checkbox" v-model="kinds[k]" /><i :style="{ background: `var(--c-${v.c})` }"></i>{{ v.t }} {{ count(k as string) }}</label></div>
        <input v-model="q" class="inp" placeholder="搜轨迹…" />
      </div>
      <div class="bands" v-if="span">
        <div v-for="r in bandRows" :key="r.k" class="brow"><span class="bl">{{ BAND[r.k][0] }}</span>
          <div class="btrack"><i v-for="(b, j) in r.bars" :key="j" :style="{ left: b.left + '%', width: b.width + '%', background: BAND[r.k][1] }"></i></div></div>
        <div class="bax"><span>{{ d.start.slice(5, 16) }}</span><span>共 {{ dms(span.len) }}</span><span>{{ d.end.slice(5, 16) }}</span></div>
      </div>
    </div>
    <div class="card list">
      <div v-for="x in items.slice(-800)" :key="x.i" class="row" :class="x.kind">
        <span class="tm mono">{{ x.at.slice(11, 19) }}</span>
        <span class="kt" :style="{ color: `var(--c-${KIND[x.kind].c})`, borderColor: `var(--c-${KIND[x.kind].c})` }">{{ KIND[x.kind].t }}</span>
        <div class="body" @click="open[x.i] = !open[x.i]">
          <div class="txt" :class="{ full: open[x.i] }"><b v-if="x.name" class="mono">{{ x.name }}</b> {{ x.text }}<span v-if="x.detail && !open[x.i]" class="arrow muted"> → {{ x.detail.replace(/\s+/g, " ").slice(0, 120) }}</span></div>
          <pre v-if="open[x.i] && x.detail" class="log">{{ x.detail }}</pre>
        </div>
        <span class="meta mono"><span v-if="x.ok === false" class="st failed">失败</span>{{ x.ms != null ? dms(x.ms) : "" }}</span>
      </div>
      <div v-if="items.length > 800" class="muted small">只显示最近 800 条，用上面的搜索缩小范围</div>
      <div v-if="!items.length" class="empty">没有符合条件的轨迹</div>
    </div>
  </template>
</template>

<style scoped>
.card { margin-bottom: var(--gap); }
.bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.seg { display: inline-flex; flex-wrap: wrap; background: var(--side); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--ink2); padding: 4px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.seg button.on { background: var(--card); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
.kinds { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
.kd { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.kd i { width: 8px; height: 8px; border-radius: 2px; }
.inp { margin-left: auto; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 9px; padding: 5px 10px; font: 13px var(--font); outline: none; min-width: 200px; }
.bands { margin-top: 14px; }
.brow { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 8px; align-items: center; margin-bottom: 4px; font-size: 11px; color: var(--ink3); }
.btrack { position: relative; height: 10px; background: var(--line2); border-radius: 3px; }
.btrack i { position: absolute; top: 0; bottom: 0; border-radius: 2px; min-width: 2px; }
.bax { display: flex; justify-content: space-between; margin-left: 42px; font: 11px var(--num); color: var(--ink3); }
.list { padding: 6px 0; }
.row { display: grid; grid-template-columns: 70px 44px minmax(0, 1fr) 90px; gap: 10px; align-items: start; padding: 7px var(--pad); border-top: 1px solid var(--line2); font-size: 13px; }
.row:first-child { border-top: none; }
.row.user { background: var(--ok-bg); }
.tm { font-size: 11.5px; color: var(--ink3); padding-top: 2px; }
.kt { font-size: 11px; border: 1px solid; border-radius: 5px; text-align: center; line-height: 18px; }
.body { cursor: pointer; min-width: 0; }
.txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.txt.full { white-space: pre-wrap; word-break: break-word; }
.row.thinking .txt { color: var(--ink3); font-style: italic; }
.body pre.log { margin-top: 6px; max-height: 300px; }
.meta { text-align: right; font-size: 11.5px; color: var(--ink3); display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.small { font-size: 12px; padding: 8px var(--pad); }
@media (max-width: 900px) { .row { grid-template-columns: 56px 40px minmax(0, 1fr); } .meta { display: none; } .inp { margin-left: 0; flex: 1; min-width: 0; } }
</style>

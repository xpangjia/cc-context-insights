<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import SessionContext from "./SessionContext.vue";
import SessionTrace from "./SessionTrace.vue";
import SessionFleet from "./SessionFleet.vue";
import { get } from "../lib/api";
import { tk } from "../lib/ctx";

const route = useRoute(), router = useRouter();
const s = ref<any>(null), err = ref(""), copied = ref(false);
const TABS = [{ k: "context", t: "上下文" }, { k: "trace", t: "轨迹" }, { k: "fleet", t: "编队" }];
const tab = computed(() => (route.query.tab as string) || "context");
const setTab = (k: string) => router.replace({ query: { ...route.query, tab: k } });
const agents = ref<{ id: string; title: string }[]>([{ id: "main", title: "主控" }]);
const ctxKey = ref(0), ctxAgent = ref("main");
/** bare=1:宿主页面自己有会话信息,这里只留页签和内容 */
const bare = computed(() => route.query.bare === "1");

async function load() {
  err.value = "";
  try { s.value = await get(`/api/session?id=${route.query.id}`); } catch { err.value = "找不到这个会话（可能还在建索引，稍后刷新）"; return; }
  try {
    const f = await get(`/api/session/fleet?id=${route.query.id}`);
    agents.value = [{ id: "main", title: "主控" }, ...f.subs.map((x: any) => ({ id: x.id, title: x.title }))];
  } catch {}
}
async function openAgent(id: string) { ctxAgent.value = id; ctxKey.value++; setTab("context"); await nextTick(); }
async function copy() { await navigator.clipboard.writeText(s.value.resume); copied.value = true; setTimeout(() => (copied.value = false), 1500); }
const span = (a: string, b: string) => { const m = Math.round((new Date(b.replace(" ", "T")).getTime() - new Date(a.replace(" ", "T")).getTime()) / 60000); return m < 60 ? `${m} 分钟` : m < 1440 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 1440).toFixed(1)} 天`; };
watch(() => route.query.id, load);
onMounted(load);
</script>

<template>
  <div v-if="err" class="card empty">{{ err }}，<RouterLink to="/" class="lk">回到总览</RouterLink></div>
  <template v-else-if="s">
    <div v-if="!bare" class="card head">
      <div class="crumbs"><RouterLink to="/">上下文洞察</RouterLink><span>/</span><span>{{ s.where }}</span><span v-if="s.auto" class="tag">脚本自动</span></div>
      <h1>{{ (s.title ?? "（没有输入）").replace(/\s+/g, " ").slice(0, 200) }}</h1>
      <div class="kv">
        <span>时间<b>{{ s.first_at?.slice(5, 16) }} → {{ s.last_at?.slice(5, 16) }}（{{ span(s.first_at, s.last_at) }}）</b></span>
        <span>提问<b>{{ s.prompts }} 次</b></span><span>回复<b>{{ s.replies }} 次</b></span>
        <span>输出<b>{{ tk(s.out_tokens) }} token</b></span>
        <span v-if="s.subagents">子 Agent<b>{{ s.subagents }} 个</b></span>
        <span>模型<b>{{ s.model ?? "—" }}</b></span><span v-if="s.branch">分支<b>{{ s.branch }}</b></span>
        <span v-if="s.cwd">目录<b class="mono">{{ s.cwd }}</b></span>
      </div>
      <div class="resume"><code>{{ s.resume }}</code><button class="btn sm" @click="copy">{{ copied ? "已复制" : "复制" }}</button><span class="muted">在终端里接着这个会话</span></div>
    </div>
    <div class="tabs">
      <button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="setTab(t.k)">{{ t.t }}<span v-if="t.k === 'fleet' && agents.length > 1" class="n">{{ agents.length - 1 }}</span></button>
    </div>
    <SessionContext v-if="tab === 'context'" :key="ctxKey" :id="s.id" :agents="agents" :initial="ctxAgent" />
    <SessionTrace v-else-if="tab === 'trace'" :id="s.id" :agents="agents" />
    <SessionFleet v-else :id="s.id" @context="openAgent" />
  </template>
</template>

<style scoped>
.head { margin-bottom: 14px; }
.crumbs { display: flex; gap: 6px; font-size: 12px; color: var(--ink3); align-items: center; }
.crumbs a:hover { color: var(--acc); }
h1 { font: 600 20px/1.45 var(--font-head); margin: 6px 0 12px; word-break: break-word; }
.kv { display: flex; flex-wrap: wrap; gap: 6px 24px; font-size: 13px; color: var(--ink2); }
.kv b { color: var(--ink); font-weight: 500; margin-left: 6px; }
.kv b.mono { font-size: 12px; }
.resume { display: flex; gap: 10px; align-items: center; margin-top: 14px; font-size: 12px; flex-wrap: wrap; }
.resume code { font: 12px var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: var(--gap); }
.tabs button { border: 0; background: none; padding: 8px 16px; font-size: 14px; color: var(--ink2); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: flex; gap: 6px; align-items: center; }
.tabs button.on { color: var(--acc); border-bottom-color: var(--acc); font-weight: 600; }
.tabs .n { font: 600 11px var(--num); background: var(--acc-soft); color: var(--acc); border-radius: 8px; padding: 0 6px; }
</style>

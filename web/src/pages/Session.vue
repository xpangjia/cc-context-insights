<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import SessionContext from "./SessionContext.vue";
import SessionTrace from "./SessionTrace.vue";
import SessionFleet from "./SessionFleet.vue";
import { get, post } from "../lib/api";
import PinIcon from "../components/PinIcon.vue";
import { tk } from "../lib/ctx";
import { embedded } from "../lib/embed";
import SessionSearch from "../components/SessionSearch.vue";

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
// 返回:应用内有上一页就退回去(保留来时的滚动和筛选),直接打开的链接就回总览
function goBack() { window.history.state?.back ? router.back() : router.push("/"); }
// 改名和固定
const editing = ref(false), draft = ref(""), nameInp = ref<HTMLInputElement>();
async function startEdit() { draft.value = s.value.name ?? title.value; editing.value = true; await nextTick(); nameInp.value?.select(); }
async function saveName() {
  if (!editing.value) return;
  editing.value = false;
  const v = draft.value.trim();
  if (v === (s.value.name ?? title.value)) return;
  const r = await post("/api/session/label", { id: s.value.id, name: v === title.value ? "" : v });
  s.value.name = r.name;
}
async function togglePin() { const r = await post("/api/session/label", { id: s.value.id, pinned: !s.value.pinned }); s.value.pinned = r.pinned; }
const title = computed(() => (s.value?.title ?? "（没有输入）").replace(/\s+/g, " ").slice(0, 200));
async function copy() { await navigator.clipboard.writeText(s.value.resume); copied.value = true; setTimeout(() => (copied.value = false), 1500); }
const span = (a: string, b: string) => { const m = Math.round((new Date(b.replace(" ", "T")).getTime() - new Date(a.replace(" ", "T")).getTime()) / 60000); return m < 60 ? `${m} 分钟` : m < 1440 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 1440).toFixed(1)} 天`; };
watch(() => route.query.id, load);
onMounted(load);
</script>

<template>
  <div v-if="err" class="card empty">{{ err }}，<RouterLink to="/" class="lk">回到总览</RouterLink></div>
  <template v-else-if="s">
    <div v-if="!bare" class="card head">
      <div class="crumbs"><button class="back" @click="goBack" title="返回上一页">← 返回</button><RouterLink to="/">上下文洞察</RouterLink><span>/</span><span>{{ s.where }}</span><span v-if="s.auto" class="tag">脚本自动</span><SessionSearch v-if="embedded" class="crs" /></div>
      <div class="titlerow">
        <input v-if="editing" ref="nameInp" v-model="draft" class="nameinp" maxlength="120" placeholder="给这个会话起个名字，清空就恢复原标题"
          @keydown.enter="saveName" @keydown.esc="editing = false" @blur="saveName" />
        <h1 v-else>{{ s.name ?? title }}</h1>
        <div v-if="!editing" class="acts">
          <button class="btn sm" @click="startEdit">改名</button>
          <button class="btn sm" :class="{ pinned: s.pinned }" @click="togglePin"><PinIcon :on="s.pinned" :size="13" /> {{ s.pinned ? "已固定" : "固定" }}</button>
        </div>
      </div>
      <div v-if="s.name && !editing" class="orig muted">原标题：{{ title }}</div>
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
.crumbs .crs { margin-left: auto; }
.back { border: 1px solid var(--line); background: var(--card); color: var(--ink2); border-radius: 7px; padding: 1px 9px; font: 12px var(--font); cursor: pointer; margin-right: 6px; }
.back:hover { color: var(--acc); border-color: var(--acc); }
.titlerow { display: flex; gap: 12px; align-items: flex-start; margin: 6px 0 12px; }
.titlerow h1 { flex: 1; margin: 0; }
.acts { display: flex; gap: 6px; flex: none; padding-top: 2px; }
.acts .pinned { color: var(--acc); border-color: var(--acc); }
.nameinp { flex: 1; font: 600 20px/1.45 var(--font-head); border: 1px solid var(--acc); border-radius: 8px; padding: 2px 10px; background: var(--card); color: var(--ink); outline: none; }
.orig { font-size: 12px; margin: -6px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

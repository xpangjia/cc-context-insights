<script setup lang="ts">
/** 搜会话并跳转:不分时间范围;按 / 随时聚焦,↑↓ 选,回车打开,Esc 收起 */
import { ref, watch, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { get } from "../lib/api";
import { ago } from "../lib/ctx";

type Hit = { id: string; title: string | null; lastPrompt: string | null; said: string | null; lastAt: string; auto: boolean; subagents: number; where: string };
const router = useRouter();
const q = ref(""), hits = ref<Hit[]>([]), open = ref(false), cur = ref(0);
const inp = ref<HTMLInputElement>();
let seq = 0, timer: number;

async function search() {
  const my = ++seq;
  const r = await get(`/api/search?q=${encodeURIComponent(q.value)}`).catch(() => []);
  if (my === seq) { hits.value = r; cur.value = 0; }
}
watch(q, () => { clearTimeout(timer); timer = window.setTimeout(search, 150); });
function show() { open.value = true; search(); }
function go(h?: Hit) {
  if (!h) return;
  open.value = false; q.value = ""; inp.value?.blur();
  router.push(`/session?id=${h.id}&tab=context`);
}
function key(e: KeyboardEvent) {
  if (e.key === "ArrowDown") { cur.value = Math.min(hits.value.length - 1, cur.value + 1); e.preventDefault(); }
  else if (e.key === "ArrowUp") { cur.value = Math.max(0, cur.value - 1); e.preventDefault(); }
  else if (e.key === "Enter") go(hits.value[cur.value]);
  else if (e.key === "Escape") { open.value = false; inp.value?.blur(); }
}
function slash(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (e.key !== "/" || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  e.preventDefault(); inp.value?.focus();
}
const one = (s: string | null) => (s ?? "").replace(/\s+/g, " ");
onMounted(() => window.addEventListener("keydown", slash));
onUnmounted(() => window.removeEventListener("keydown", slash));
</script>

<template>
  <div class="ss" @focusout="e => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && (open = false)">
    <svg class="ic" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
    <input ref="inp" v-model="q" class="si" placeholder="搜会话：说过的话、标题、目录" @focus="show" @keydown="key" />
    <kbd>/</kbd>
    <div v-if="open" class="dd" tabindex="-1">
      <div class="dh muted">{{ q.trim() ? `找到 ${hits.length === 12 ? "12+" : hits.length} 个` : "最近的会话" }}</div>
      <button v-for="(h, i) in hits" :key="h.id" class="hit" :class="{ on: i === cur }" @mouseenter="cur = i" @mousedown.prevent="go(h)">
        <div class="ht"><span class="tt">{{ one(h.title) || "（没有输入）" }}</span><span class="tm muted">{{ ago(h.lastAt) }}</span></div>
        <div class="hm muted"><span class="tag">{{ h.where }}</span><span v-if="h.auto" class="tag">脚本自动</span><span v-if="h.subagents" class="tag">{{ h.subagents }} 个子 Agent</span><span class="lp">{{ h.said ? "说过：" + one(h.said) : one(h.lastPrompt) }}</span></div>
      </button>
      <div v-if="!hits.length" class="none muted">没有匹配的会话</div>
    </div>
  </div>
</template>

<style scoped>
.ss { position: relative; display: flex; align-items: center; width: 340px; max-width: 100%; }
.ic { position: absolute; left: 10px; color: var(--ink3); pointer-events: none; }
.si { width: 100%; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 9px; padding: 6px 34px 6px 30px; font: 13px var(--font); outline: none; }
.si:focus { border-color: var(--acc); }
kbd { position: absolute; right: 8px; font: 11px var(--mono); color: var(--ink3); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; background: var(--bg); pointer-events: none; }
.dd { position: absolute; top: calc(100% + 6px); right: 0; width: min(520px, 92vw); max-height: 440px; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, .14); padding: 6px; z-index: 30; }
.dh { font-size: 12px; padding: 4px 8px 6px; }
.hit { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ink); border-radius: 8px; padding: 8px 10px; cursor: pointer; font: inherit; }
.hit.on { background: var(--hover); }
.ht { display: flex; gap: 10px; justify-content: space-between; }
.tt { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm { font-size: 11.5px; white-space: nowrap; }
.hm { display: flex; gap: 6px; align-items: center; margin-top: 3px; font-size: 12px; min-width: 0; }
.lp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.none { padding: 10px; font-size: 13px; }
</style>

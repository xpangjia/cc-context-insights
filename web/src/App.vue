<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { get } from "./lib/api";
import { embedded } from "./lib/embed";
import SessionSearch from "./components/SessionSearch.vue";
const st = ref<any>(null);
let t: number;
async function poll() { try { st.value = await get("/api/status"); } catch {} }
onMounted(() => { poll(); t = window.setInterval(poll, 5000); });
onUnmounted(() => clearInterval(t));
const time = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
</script>

<template>
  <header v-if="!embedded" class="top">
    <RouterLink to="/" class="brand"><span class="logo">C</span><b>Claude Code 上下文洞察</b></RouterLink>
    <SessionSearch />
    <span class="idx" v-if="st">
      <template v-if="!st.logsFound"><span class="st failed">没找到会话日志</span>{{ st.logs }}</template>
      <template v-else-if="st.index?.ok === null || !st.index?.at"><span class="st running">正在建索引</span>第一次要几秒到一两分钟</template>
      <template v-else-if="st.index?.ok"><span class="dot"></span>索引于 {{ time(st.index.at) }} · 每 2 分钟自动更新</template>
      <template v-else><span class="st failed">索引出错</span>{{ st.index.error }}</template>
    </span>
  </header>
  <main :class="{ embedded }"><RouterView /></main>
  <footer v-if="!embedded" class="foot">只读本机 {{ st?.logs ?? "~/.claude/projects" }} 下的会话日志，数据不出这台电脑。费用按 Anthropic 官方价估算，和你实际付的可能不同。</footer>
</template>

<style scoped>
.top { display: flex; align-items: center; gap: 16px; padding: 14px 32px; border-bottom: 1px solid var(--line); background: var(--side); position: sticky; top: 0; z-index: 10; flex-wrap: wrap; }
.top .ss { margin-left: 12px; }
.top .ss :deep(.dd) { left: 0; right: auto; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.logo { width: 28px; height: 28px; border-radius: 8px; background: var(--acc); color: var(--on-acc); display: grid; place-items: center; font: 700 15px var(--num); }
.idx { margin-left: auto; display: flex; gap: 8px; align-items: center; color: var(--ink3); font-size: 12.5px; }
main { padding: 24px 32px 40px; max-width: 1440px; margin: 0 auto; }
main.embedded { padding: 4px 2px 24px; max-width: none; }
.foot { text-align: center; color: var(--ink3); font-size: 12px; padding: 0 20px 30px; }
@media (max-width: 900px) { .top { padding: 12px 14px; } main:not(.embedded) { padding: 16px 12px 30px; } }
</style>

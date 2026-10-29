<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import StackBar from "../components/StackBar.vue";
import { get } from "../lib/api";
import { CATS, CAT_CN, color, tk, pct, usd, dms } from "../lib/ctx";

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ context: [agent: string] }>();
const d = ref<any>(null);
const focus = ref<string | null>(null);
const taskFilter = ref(""), taskOpen = ref<Record<string, boolean>>({}), commOpen = ref<Record<number, boolean>>({});
onMounted(async () => { d.value = await get(`/api/session/fleet?id=${props.id}`); });
const STATUS: Record<string, string> = { 主控: "running", 运行中: "running", 已完成: "ok", 失败: "failed" };
const segs = (cats: any) => cats ? CATS.map(k => ({ key: k as string, label: CAT_CN[k], value: cats[k], color: color(k) })) : [];
const subs = computed(() => d.value?.subs ?? []);
const tasks = computed(() => (d.value?.tasks ?? []).filter((t: any) => (!taskFilter.value || t.status === taskFilter.value) && (!focus.value || t.id === focus.value)));
const comms = computed(() => (d.value?.comms ?? []).map((c: any, i: number) => ({ ...c, i })).filter((c: any) => !focus.value || c.agent === focus.value));
const channels = computed(() => subs.value.map((s: any) => ({ id: s.id, title: s.title, out: d.value.comms.filter((c: any) => c.agent === s.id && c.dir === "去").length, back: d.value.comms.filter((c: any) => c.agent === s.id && c.dir === "回").length })).filter((c: any) => c.out + c.back));
const pick = (id: string | null) => (focus.value = focus.value === id ? null : id);
</script>

<template>
  <div v-if="!d" class="card empty">正在整理编队…</div>
  <div v-else-if="!subs.length" class="card empty">这个会话没有派子 Agent</div>
  <template v-else>
    <div class="card sumbar">
      <span class="pill">{{ d.summary.agents }} 个 Agent</span><span class="pill">{{ d.summary.running }} 个运行中</span><span class="pill">{{ d.summary.done }} 个已完成</span>
      <span v-if="d.summary.failed" class="pill bad">{{ d.summary.failed }} 个失败</span>
      <span class="pill">上下文合计 {{ tk(d.summary.ctxTotal) }}</span><span class="pill">Token 合计 {{ tk(d.summary.billed) }}</span><span class="pill">约 {{ usd(d.summary.cost) }}</span>
      <span class="prog"><span class="muted">子 Agent 进度</span><span class="pbar"><i :style="{ width: (d.summary.done / subs.length) * 100 + '%' }"></i></span><b>{{ d.summary.done }}/{{ subs.length }}</b></span>
    </div>

    <div class="grid">
      <div class="card net">
        <h2 class="card-title">Agent 网络<span class="more muted">点卡片只看这个 Agent 的任务和通讯</span></h2>
        <div class="tree">
          <div class="node main" :class="{ on: focus === null }" @click="pick(null)">
            <div class="nh"><span class="dot"></span><b>{{ d.main.title.replace(/\s+/g, " ").slice(0, 40) }}</b><span class="tag">主控</span></div>
            <div class="nv">{{ tk(d.main.billed) }} · {{ usd(d.main.cost) }}</div>
            <StackBar :segs="segs(d.main.cats)" :total="1000000" :height="7" />
            <div class="nf"><span>{{ dms(d.main.durMs) }} · {{ d.main.steps }} 步</span><b>{{ pct(d.main.ctxPct) }}</b></div>
          </div>
          <div class="wires"><i v-for="s in subs" :key="s.id"></i></div>
          <div class="kids">
            <div v-for="s in subs" :key="s.id" class="node" :class="{ on: focus === s.id }" @click="pick(s.id)">
              <div class="nh"><span class="dot" :class="STATUS[s.status]"></span><b>{{ s.title }}</b></div>
              <div class="nv">{{ tk(s.billed) }} · {{ usd(s.cost) }}</div>
              <StackBar :segs="segs(s.cats)" :total="1000000" :height="7" />
              <div class="nf"><span>{{ dms(s.durMs) }} · {{ s.steps }} 步</span><b>{{ pct(s.ctxPct) }}</b></div>
            </div>
          </div>
        </div>
        <div class="lg"><span v-for="k in CATS" :key="k"><i :style="{ background: color(k) }"></i>{{ CAT_CN[k] }}</span><span class="muted">条形 = 当前上下文占 100 万窗口的组成</span></div>
      </div>

      <div class="col">
        <div class="card">
          <h2 class="card-title">编队成员<span class="tag">{{ d.summary.agents }}</span></h2>
          <div class="members">
            <div v-for="s in [d.main, ...subs]" :key="s.id" class="mem" :class="{ on: focus === s.id || (s.role === '主控' && !focus) }">
              <div class="mh"><b>{{ s.role === "主控" ? "主控" : s.title }}</b><span class="st" :class="STATUS[s.status]">{{ s.status }}</span></div>
              <div class="mm muted">{{ s.model ?? "—" }}{{ s.type ? " · " + s.type : "" }}{{ s.background ? " · 后台" : "" }}</div>
              <div class="mr" v-if="s.lastReply">最新回报：{{ s.lastReply }}</div>
              <div class="mf"><span class="muted">{{ dms(s.durMs) }} · {{ s.steps }} 步</span><button class="btn sm" @click="emit('context', s.id)">看上下文</button></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">任务<span class="more muted">派给子 Agent 的活</span>
        <div class="seg sm right"><button :class="{ on: !taskFilter }" @click="taskFilter = ''">全部 {{ d.tasks.length }}</button><button v-for="k in ['运行中', '已完成', '失败']" :key="k" :class="{ on: taskFilter === k }" @click="taskFilter = k">{{ k }} {{ d.tasks.filter((t: any) => t.status === k).length }}</button></div></h2>
      <div v-for="t in tasks" :key="t.id" class="task" @click="taskOpen[t.id] = !taskOpen[t.id]">
        <div class="th"><span class="st" :class="STATUS[t.status]">{{ t.status }}</span><b>{{ t.title }}</b><span class="muted small">{{ t.type }}{{ t.background ? " · 后台" : "" }} · {{ dms(t.durMs) }} · {{ t.steps }} 步</span></div>
        <div class="tp" :class="{ full: taskOpen[t.id] }">{{ t.prompt }}</div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">通讯记录<span class="more muted">{{ d.comms.length }} 条 · {{ channels.length }} 个通道</span></h2>
      <div class="chans">
        <div class="chan" :class="{ on: !focus }" @click="pick(null)"><b>全部通讯</b><span class="muted">{{ d.comms.length }} 条</span></div>
        <div v-for="c in channels" :key="c.id" class="chan" :class="{ on: focus === c.id }" @click="pick(c.id)"><b>主控 ⇄ {{ c.title }}</b><span class="muted">派活 {{ c.out }} · 回报 {{ c.back }}</span></div>
      </div>
      <div v-for="c in comms" :key="c.i" class="msg" :class="c.dir === '去' ? 'out' : 'back'" @click="commOpen[c.i] = !commOpen[c.i]">
        <div class="mh2"><span class="mono muted">{{ c.at.slice(5, 19) }}</span>
          <b>{{ c.dir === "去" ? "主控" : c.title }}</b><span class="arrow">→</span><b>{{ c.dir === "去" ? c.title : "主控" }}</b>
          <span class="tag">{{ c.kind }}</span><span v-if="c.status" class="st" :class="c.status === 'completed' ? 'ok' : 'failed'">{{ c.status === "completed" ? "完成" : c.status }}</span></div>
        <div class="mt" :class="{ full: commOpen[c.i] }">{{ c.text }}</div>
      </div>
      <div v-if="!comms.length" class="empty">没有通讯</div>
    </div>
  </template>
</template>

<style scoped>
.card { margin-bottom: var(--gap); }
.sumbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px var(--pad); }
.pill { border: 1px solid var(--line); border-radius: 8px; padding: 2px 10px; font-size: 12.5px; }
.pill.bad { color: var(--bad); border-color: var(--bad); }
.prog { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 12.5px; }
.pbar { width: 160px; height: 6px; background: var(--line2); border-radius: 3px; overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--ok); }
.grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--gap); align-items: start; }
.col { min-width: 0; }
.tree { display: flex; flex-direction: column; align-items: center; }
.node { width: 100%; max-width: 300px; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--card); cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.node:hover { border-color: var(--acc); }
.node.on { border-color: var(--acc); box-shadow: 0 0 0 2px var(--acc-soft); }
.nh { display: flex; gap: 6px; align-items: center; font-size: 13px; min-width: 0; }
.nh b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.dot.running { background: var(--run); animation: pulse 1.4s infinite; } .dot.failed { background: var(--bad); }
@keyframes pulse { 50% { opacity: .3; } }
.nv { font: 600 15px var(--num); margin: 6px 0; }
.nf { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--ink3); margin-top: 6px; }
.nf b { color: var(--ok); font-family: var(--num); }
.wires { width: 2px; height: 22px; background: var(--line); }
.kids { width: 100%; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; padding-top: 12px; border-top: 2px solid var(--line); }
.kids .node { max-width: none; }
.lg { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11.5px; margin-top: 14px; }
.lg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.members { display: flex; flex-direction: column; gap: 10px; max-height: 620px; overflow: auto; }
.mem { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.mem.on { border-color: var(--acc); }
.mh { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 13px; }
.mm { font-size: 11.5px; margin-top: 2px; }
.mr { font-size: 12px; color: var(--ink2); margin-top: 6px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-style: italic; }
.mf { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 12px; }
.seg { display: inline-flex; background: var(--side); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--ink2); padding: 3px 9px; border-radius: 7px; cursor: pointer; font-size: 12px; }
.seg button.on { background: var(--card); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
.right { margin-left: auto; font-weight: 400; }
.small { font-size: 12px; }
.task { border-top: 1px solid var(--line2); padding: 10px 0; cursor: pointer; }
.th { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13.5px; }
.tp { font-size: 12.5px; color: var(--ink2); margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-wrap; }
.tp.full, .mt.full { display: block; -webkit-line-clamp: unset; }
.chans { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.chan { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; cursor: pointer; display: flex; flex-direction: column; font-size: 12.5px; }
.chan.on { border-color: var(--acc); background: var(--acc-soft); }
.msg { border-left: 3px solid var(--c-system); background: var(--bg); border-radius: 0 8px 8px 0; padding: 8px 12px; margin-bottom: 8px; cursor: pointer; }
.msg.back { border-left-color: var(--ok); }
.mh2 { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
.arrow { color: var(--ink3); }
.mt { font-size: 12.5px; color: var(--ink2); margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 1100px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>

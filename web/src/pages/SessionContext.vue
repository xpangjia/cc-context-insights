<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Donut from "../components/Donut.vue";
import StackBar from "../components/StackBar.vue";
import TrendChart from "../components/TrendChart.vue";
import { get } from "../lib/api";
import { CATS, CAT_CN, color, tk, pct, usd, dms } from "../lib/ctx";

const props = defineProps<{ id: string; agents: { id: string; title: string }[]; initial?: string }>();
const agent = ref(props.initial || "main");
const d = ref<any>(null), err = ref("");
const sel = ref<number | null>(null);
const br = ref<any>(null);
const openCat = ref<Record<string, boolean>>({});
const openItem = ref<Record<number, boolean>>({});
const catQ = ref<Record<string, string>>({});
const mode = ref<"total" | "delta">("total"), fit = ref(false);
const evFilter = ref<string>(""), fileFilter = ref<string>(""), fileQ = ref(""), cmdQ = ref(""), cmdProg = ref("");
const openCmd = ref<Record<number, boolean>>({});

async function load() {
  err.value = ""; d.value = null; br.value = null;
  try { d.value = await get(`/api/session/context?id=${props.id}&agent=${agent.value}`); } catch { err.value = "读不到这个会话的上下文"; return; }
  fit.value = d.value.trend.length > 120;
  sel.value = d.value.current?.idx ?? null;
}
async function loadBrowser() {
  if (sel.value == null) return;
  br.value = await get(`/api/session/request?id=${props.id}&agent=${agent.value}&idx=${sel.value}`);
  openItem.value = {};
}
watch(agent, load);
watch(sel, loadBrowser);
watch(() => props.id, load);
onMounted(load);

const segsOf = (cats: Record<string, number>) => CATS.map(k => ({ key: k as string, label: CAT_CN[k], value: cats[k] ?? 0, color: color(k) }));
const tokenSegs = computed(() => d.value ? [...CATS.map(k => ({ key: k as string, label: CAT_CN[k], value: d.value.tokens.cats[k], color: color(k), sub: `约 ${tk(d.value.tokens.cats[k])}` })),
  { key: "output", label: "输出", value: d.value.tokens.output, color: color("output"), sub: `${tk(d.value.tokens.output)} · 含思考` }] : []);
const timeSegs = computed(() => d.value ? [
  { key: "model", label: "模型调用", value: d.value.timing.modelMs, color: color("system"), sub: `${dms(d.value.timing.modelMs)} · ${d.value.timing.modelCalls} 次` },
  { key: "tool", label: "工具执行", value: d.value.timing.toolMs, color: color("user"), sub: `${dms(d.value.timing.toolMs)} · ${d.value.timing.toolCalls} 次` },
  { key: "other", label: "其他开销", value: d.value.timing.otherMs, color: color("unsplit"), sub: dms(d.value.timing.otherMs) },
] : []);
const marks = computed(() => (d.value?.events ?? []).filter((e: any) => e.kind === "compact" || e.kind === "prune").map((e: any) => ({ req: e.req, text: e.text })));
const evCount = (k: string) => (d.value?.events ?? []).filter((e: any) => e.kind === k).length;
const EV_CN: Record<string, string> = { inject: "注入", compact: "压缩", prune: "清理", switch: "换模型", mode: "权限模式" };
const events = computed(() => (d.value?.events ?? []).filter((e: any) => !evFilter.value || e.kind === evFilter.value).slice().reverse());
const files = computed(() => (d.value?.files ?? []).filter((f: any) => (!fileFilter.value || f[fileFilter.value] > 0) && (!fileQ.value || f.path.includes(fileQ.value))));
const fileSum = computed(() => (d.value?.files ?? []).reduce((a: any, f: any) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 }));
const cmds = computed(() => (d.value?.commands ?? []).filter((c: any) => (!cmdProg.value || c.program === cmdProg.value) && (!cmdQ.value || c.cmd.includes(cmdQ.value))));
/** 路径里的用户目录显示成 ~/(macOS 的 /Users/名字、Linux 的 /home/名字) */
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+\//, "~/");
const groupItems = (g: any) => g.items.filter((i: any) => !catQ.value[g.cat] || `${i.kind} ${i.name ?? ""} ${i.text}`.toLowerCase().includes(catQ.value[g.cat].toLowerCase()));
</script>

<template>
  <div v-if="err" class="card empty">{{ err }}</div>
  <div v-else-if="!d" class="card empty">正在还原每次请求的上下文…</div>
  <template v-else>
    <div v-if="agents.length > 1" class="agentbar">
      <span class="muted">看谁的上下文</span>
      <div class="seg sm"><button v-for="a in agents" :key="a.id" :class="{ on: agent === a.id }" @click="agent = a.id">{{ a.title }}</button></div>
    </div>

    <div class="card stats">
      <h2 class="card-title">上下文统计</h2>
      <div class="tiles">
        <div class="tile"><b>{{ d.stats.turns }}</b><span>轮次（你发的消息）</span></div>
        <div class="tile"><b>{{ d.stats.steps }}</b><span>步数（模型请求）</span></div>
        <div class="tile"><b>{{ d.stats.skills.length }}</b><span>技能加载</span></div>
        <div class="tile"><b>{{ d.stats.replies }}</b><span>模型回复</span></div>
        <div class="tile ev"><span>上下文事件</span><div><em class="c-inj">注入 {{ d.stats.events.inject }}</em> / <em class="c-cmp">压缩 {{ d.stats.events.compact }}</em> / <em class="c-prn">清理 {{ d.stats.events.prune }}</em></div></div>
      </div>
      <div class="lines">
        <div class="line"><span class="h">输入输出</span>
          <span class="chip"><i style="background: var(--c-user)"></i>你 {{ d.stats.io.user }}</span><span class="chip"><i style="background: var(--c-system)"></i>读取 {{ d.stats.io.read }}</span>
          <span class="chip"><i style="background: var(--c-assistant)"></i>写入 {{ d.stats.io.write }}</span><span class="chip"><i style="background: var(--c-tools)"></i>搜索 {{ d.stats.io.search }}</span>
          <span class="chip"><i style="background: var(--c-skill)"></i>图片 {{ d.stats.io.images }}</span></div>
        <div class="line"><span class="h">工具调用 {{ d.stats.toolTotal }}</span>
          <span v-for="[n, c] in d.stats.tools.slice(0, 6)" :key="n" class="chip">{{ n }} {{ c }}</span><span v-if="d.stats.tools.length > 6" class="chip muted">其他 +{{ d.stats.tools.length - 6 }}</span></div>
        <div class="line"><span class="h">命令执行 {{ d.stats.bashTotal }}</span>
          <span v-for="[n, c] in d.stats.programs.slice(0, 6)" :key="n" class="chip mono">{{ n }} {{ c }}</span><span v-if="d.stats.programs.length > 6" class="chip muted">其他 +{{ d.stats.programs.length - 6 }}</span></div>
        <div v-if="d.stats.fleet.agents" class="line"><span class="h">编队</span>
          <span class="chip">主控 {{ tk(d.stats.fleet.mainBilled) }} / {{ usd(d.stats.fleet.mainCost) }}</span>
          <span class="chip">子 Agent × {{ d.stats.fleet.agents }} {{ tk(d.stats.fleet.subBilled) }} / {{ usd(d.stats.fleet.subCost) }}</span></div>
      </div>
    </div>

    <div class="row2">
      <div class="card">
        <h2 class="card-title">Token 统计<span class="more muted">缓存命中 {{ pct(d.tokens.cacheHit, 2) }} · 约 {{ usd(d.tokens.cost) }}</span></h2>
        <Donut :segs="tokenSegs" :center="tk(d.tokens.billed)" center-sub="总用量" :size="128" />
        <div class="note muted">每次请求都会把整个上下文重新发一遍，所以总用量是每次请求的上下文加起来；类别按字数估算后，按官方计量的实际输入等比换算</div>
      </div>
      <div class="card">
        <h2 class="card-title">耗时统计<span class="more muted">输出速度 {{ Math.round(d.timing.speed) }} token/秒</span></h2>
        <Donut :segs="timeSegs" :center="dms(d.timing.activeMs)" center-sub="活跃时长" :size="128" :cols="1" />
      </div>
    </div>

    <div class="row2 tall">
      <div class="card" v-if="d.current">
        <h2 class="card-title">当前上下文<span class="more muted">{{ d.model }}{{ d.current.estimated ? " · 估算" : "" }}</span></h2>
        <div class="cur"><b>{{ tk(d.current.total) }}</b><span class="muted">/ {{ tk(d.window) }} token</span><span class="pc">{{ pct(d.current.total / d.window) }}<small>已用</small></span></div>
        <StackBar :segs="segsOf(d.current.cats)" :total="d.window" :height="16" />
        <div class="curlg">
          <span v-for="s in segsOf(d.current.cats)" :key="s.key"><i :style="{ background: s.color }"></i>{{ s.label }}<b>≈{{ tk(s.value) }}</b><em>{{ pct(s.value / (d.current.total || 1), 0) }}</em></span>
        </div>
        <div class="note muted">第 {{ d.current.idx + 1 }} 次请求（最后一次）· {{ d.current.at.slice(5, 16) }}</div>
      </div>
      <div class="card browser" v-if="br">
        <h2 class="card-title">上下文浏览器<span class="more muted">第 {{ br.idx + 1 }} 次请求 · {{ br.at.slice(5, 16) }} · 合计 {{ tk(br.total) }}</span></h2>
        <StackBar :segs="br.groups.map((g: any) => ({ key: g.cat, label: CAT_CN[g.cat], value: g.tokens, color: color(g.cat) }))" :total="br.total || 1" :height="10" />
        <div class="groups">
          <div v-for="g in br.groups" :key="g.cat" class="grp">
            <div class="gh" @click="openCat[g.cat] = !openCat[g.cat]">
              <span class="arrow">{{ openCat[g.cat] ? "▾" : "▸" }}</span><i :style="{ background: color(g.cat) }"></i>
              <b>{{ CAT_CN[g.cat] }}</b><span class="muted">{{ g.count }} 项</span><span v-if="g.added" class="new">+{{ g.added }} 新</span>
              <span class="gt">≈{{ tk(g.tokens) }}</span><span class="gp muted">{{ pct(g.tokens / (br.total || 1), 0) }}</span>
            </div>
            <div v-if="openCat[g.cat]" class="items">
              <input v-if="g.count > 8" v-model="catQ[g.cat]" class="inp sm" placeholder="在这一类里搜…" />
              <div v-for="it in groupItems(g).slice(-200)" :key="it.pos" class="it" :class="{ isnew: it.isNew }">
                <div class="ih" @click="openItem[it.pos] = !openItem[it.pos]">
                  <span class="pos mono">#{{ it.pos }}</span><span class="kind">{{ it.kind }}</span><span v-if="it.name" class="tag mono">{{ it.name }}</span>
                  <span class="prev">{{ it.text.replace(/\s+/g, " ").slice(0, 90) }}</span><span class="tok mono">≈{{ tk(it.tokens) }}</span>
                </div>
                <pre v-if="openItem[it.pos]" class="log">{{ it.text }}{{ it.full > it.text.length ? `\n\n（共 ${it.full} 字，只显示前 3000 字）` : "" }}</pre>
              </div>
              <div v-if="groupItems(g).length > 200" class="muted small">只列最新的 200 项</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">上下文趋势
        <div class="right ctl">
          <div class="seg sm"><button :class="{ on: mode === 'total' }" @click="mode = 'total'">全量</button><button :class="{ on: mode === 'delta' }" @click="mode = 'delta'">增量</button></div>
          <div class="seg sm"><button :class="{ on: !fit }" @click="fit = false">逐个</button><button :class="{ on: fit }" @click="fit = true">总览</button></div>
        </div>
      </h2>
      <TrendChart :data="d.trend" :marks="marks" :selected="sel" :mode="mode" :fit="fit" @select="i => (sel = i)" />
      <div class="trendlg"><span v-for="k in CATS" :key="k"><i :style="{ background: color(k) }"></i>{{ CAT_CN[k] }}</span><span class="muted">✂ 压缩或清理 · 点柱子在上方浏览器里看这次请求</span></div>
    </div>

    <div class="row2 tall">
      <div class="card">
        <h2 class="card-title">上下文事件
          <div class="seg sm right"><button :class="{ on: !evFilter }" @click="evFilter = ''">全部 {{ d.events.length }}</button>
            <button v-for="k in ['inject', 'compact', 'prune', 'switch', 'mode']" :key="k" :class="{ on: evFilter === k }" @click="evFilter = k">{{ EV_CN[k] }} {{ evCount(k) }}</button></div>
        </h2>
        <div class="list">
          <div v-for="(e, i) in events.slice(0, 300)" :key="i" class="ev-row">
            <span class="st" :class="e.kind === 'compact' ? 'failed' : e.kind === 'prune' ? 'skipped' : e.kind === 'inject' ? 'degraded' : 'running'">{{ EV_CN[e.kind] }}</span>
            <span class="et">{{ e.text }}</span>
            <span class="mono muted">{{ e.tokens ? (e.tokens > 0 ? "+" : "") + tk(e.tokens) : "" }}</span>
            <span class="mono muted">{{ e.at.slice(5, 16) }}</span>
          </div>
          <div v-if="!events.length" class="empty">没有事件</div>
        </div>
      </div>
      <div class="card">
        <h2 class="card-title">文件活动<span class="more muted">+{{ fileSum.add }} −{{ fileSum.del }} 行</span></h2>
        <div class="fbar">
          <div class="seg sm"><button :class="{ on: !fileFilter }" @click="fileFilter = ''">全部</button><button :class="{ on: fileFilter === 'read' }" @click="fileFilter = 'read'">读取</button>
            <button :class="{ on: fileFilter === 'write' }" @click="fileFilter = 'write'">写入</button><button :class="{ on: fileFilter === 'search' }" @click="fileFilter = 'search'">搜索</button></div>
          <input v-model="fileQ" class="inp sm" placeholder="搜路径…" />
        </div>
        <div class="list">
          <div v-for="f in files.slice(0, 200)" :key="f.path" class="frow">
            <span class="fp mono" :title="f.path">{{ shortPath(f.path) }}</span>
            <span class="fc"><em v-if="f.read">读 {{ f.read }}</em><em v-if="f.write">写 {{ f.write }}</em><em v-if="f.search">搜 {{ f.search }}</em></span>
            <span class="mono fd"><b class="add" v-if="f.add">+{{ f.add }}</b><b class="del" v-if="f.del">−{{ f.del }}</b></span>
          </div>
          <div v-if="!files.length" class="empty">没有文件操作</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">命令执行<span class="tag">{{ d.commands.length }}</span>
        <span class="more muted">失败 {{ d.commands.filter((c: any) => c.ok === false).length }} · 后台 {{ d.commands.filter((c: any) => c.background).length }}</span></h2>
      <div class="cmdgrid">
        <div class="progs">
          <div class="muted small">程序分布</div>
          <div v-for="[n, c] in d.stats.programs.slice(0, 14)" :key="n" class="prog" :class="{ on: cmdProg === n }" @click="cmdProg = cmdProg === n ? '' : n">
            <span class="mono">{{ n }}</span><span class="pb"><i :style="{ width: (c / d.stats.programs[0][1]) * 100 + '%' }"></i></span><span class="mono">{{ c }}</span>
          </div>
        </div>
        <div class="cmds">
          <input v-model="cmdQ" class="inp sm" placeholder="搜命令…" />
          <div class="list">
            <div v-for="(c, i) in cmds.slice(0, 200)" :key="i" class="crow">
              <div class="ch" @click="openCmd[i] = !openCmd[i]">
                <span class="st" :class="c.ok === false ? 'failed' : c.ok ? 'ok' : 'skipped'">{{ c.ok === false ? "失败" : c.ok ? "完成" : "没结果" }}</span>
                <span class="cc mono">{{ c.cmd.replace(/\s+/g, " ").slice(0, 120) }}</span>
                <span class="mono muted">{{ c.ms != null ? dms(c.ms) : "" }}</span><span class="mono muted">{{ c.at.slice(11, 16) }}</span>
              </div>
              <div v-if="openCmd[i]" class="cd"><div v-if="c.desc" class="muted small">{{ c.desc }}</div><pre class="log">{{ c.cmd }}</pre><pre class="log">{{ c.result || "（没有输出）" }}</pre></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.agentbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; font-size: 13px; }
.seg { display: inline-flex; flex-wrap: wrap; background: var(--side); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--ink2); padding: 4px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.seg button.on { background: var(--card); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
.right { margin-left: auto; font-weight: 400; }
.ctl { display: flex; gap: 8px; }
.small { font-size: 12px; }
.card { margin-bottom: var(--gap); }
.note { font-size: 12px; margin-top: 10px; line-height: 1.6; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.6fr); gap: 10px; }
.tile { background: var(--bg); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; }
.tile b { font: 600 24px var(--num); color: var(--acc); }
.tile span { font-size: 12px; color: var(--ink3); }
.tile.ev div { margin-top: 6px; font: 600 15px var(--num); }
.c-inj { color: var(--ok); font-style: normal; } .c-cmp { color: var(--bad); font-style: normal; } .c-prn { color: var(--c-tool); font-style: normal; }
.lines { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
.line .h { width: 110px; color: var(--ink2); font-weight: 600; flex: none; }
.chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 7px; padding: 1px 8px; }
.chip i { width: 8px; height: 8px; border-radius: 2px; }
.row2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--gap); align-items: start; }
.row2 > .card { min-width: 0; }
.cur { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.cur b { font: 600 30px var(--num); }
.cur .pc { margin-left: auto; font: 600 26px var(--num); }
.cur small { font: 400 12px var(--font); color: var(--ink3); margin-left: 6px; }
.curlg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px; margin-top: 14px; font-size: 12.5px; }
.curlg span { display: flex; align-items: center; gap: 5px; }
.curlg i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
.curlg b { margin-left: auto; font: 600 12px var(--num); }
.curlg em { font-style: normal; color: var(--ink3); width: 34px; text-align: right; font-size: 12px; }
.browser .groups { margin-top: 12px; max-height: 560px; overflow: auto; }
.grp { border-top: 1px solid var(--line2); }
.gh { display: flex; gap: 8px; align-items: center; padding: 9px 2px; cursor: pointer; font-size: 13px; }
.gh:hover { background: var(--hover); }
.gh i { width: 9px; height: 9px; border-radius: 2px; }
.arrow { width: 12px; color: var(--ink3); }
.new { font-size: 11px; color: var(--ok); background: var(--ok-bg); border-radius: 5px; padding: 0 5px; }
.gt { margin-left: auto; font: 600 12.5px var(--num); }
.gp { width: 38px; text-align: right; font-size: 12px; }
.items { padding: 0 0 10px 20px; }
.inp { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 8px; padding: 5px 9px; font: 12.5px var(--font); outline: none; }
.inp.sm { margin: 4px 0 8px; }
.it { border-left: 2px solid transparent; }
.it.isnew { border-left-color: var(--ok); }
.ih { display: grid; grid-template-columns: 46px auto auto minmax(0, 1fr) 60px; gap: 8px; align-items: center; padding: 5px 4px; font-size: 12px; cursor: pointer; }
.ih:hover { background: var(--hover); }
.pos { color: var(--ink3); font-size: 11px; }
.kind { color: var(--ink2); white-space: nowrap; }
.prev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink2); }
.tok { text-align: right; font-size: 11.5px; }
.it pre.log { margin: 4px 0 8px; max-height: 320px; }
.trendlg { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 4px; font-size: 12px; }
.trendlg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
.list { max-height: 420px; overflow: auto; }
.ev-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 60px 82px; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line2); font-size: 12.5px; }
.et { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fbar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.frow { display: grid; grid-template-columns: minmax(0, 1fr) auto 90px; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line2); font-size: 12.5px; }
.fp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.fc { display: flex; gap: 6px; } .fc em { font-style: normal; font-size: 11.5px; color: var(--ink2); background: var(--bg); border-radius: 5px; padding: 0 6px; }
.fd { text-align: right; } .add { color: var(--ok); font-weight: 600; margin-right: 6px; } .del { color: var(--bad); font-weight: 600; }
.cmdgrid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; }
.prog { display: grid; grid-template-columns: 90px minmax(0, 1fr) 36px; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.prog:hover, .prog.on { background: var(--acc-soft); }
.pb { height: 8px; background: var(--line2); border-radius: 4px; overflow: hidden; }
.pb i { display: block; height: 100%; background: var(--c-user); }
.prog span:last-child { text-align: right; }
.crow { border-top: 1px solid var(--line2); }
.ch { display: grid; grid-template-columns: auto minmax(0, 1fr) 70px 44px; gap: 8px; align-items: center; padding: 6px 2px; cursor: pointer; font-size: 12.5px; }
.ch:hover { background: var(--hover); }
.cc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd { padding: 4px 0 10px; display: flex; flex-direction: column; gap: 6px; }
@media (max-width: 1100px) { .row2 { grid-template-columns: minmax(0, 1fr); } .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cmdgrid { grid-template-columns: minmax(0, 1fr); } }
</style>

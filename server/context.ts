/**
 * 单个会话的深度解析:还原每次请求的上下文,整理轨迹、工具、文件、命令、事件、编队、通讯
 * 按需解析,结果按文件修改时间缓存在内存里
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { CC_ROOT } from "./paths";
import { localTs, promptText } from "./indexer";
import { messageItems, shapeItems, scaleTo, costOf, windowOf, est, capMs, NO_TIME_TOOLS, CATS, type Cat, type Item } from "./classify";

type Usage = { input: number; read: number; w5: number; w1h: number; output: number };
export type Req = {
  idx: number; id: string; at: string; source: string; model: string | null; keys: string[]; shape: string | null;
  usage: Usage; answered: boolean; lastAt: string | null; modelMs: number; toolCalls: number;
};
export type Tool = { id: string; name: string; input: any; at: string; endAt: string | null; ms: number | null; ok: boolean | null; result: string; req: number };
type TraceKind = "user" | "assistant" | "thinking" | "tool" | "inject" | "event" | "agent";
export type TraceItem = { at: string; kind: TraceKind; text: string; detail?: string; req?: number; ms?: number | null; ok?: boolean | null; name?: string };
export type Evt = { at: string; kind: "inject" | "compact" | "prune" | "switch" | "mode"; text: string; tokens?: number; req?: number };

/** 一个 Agent(主会话或子 Agent)解析出来的全部东西 */
export type AgentModel = {
  agentId: string; file: string; shapes: Map<string, any>; msgs: Map<string, any>; reqs: Req[]; tools: Tool[];
  prompts: { at: string; text: string }[]; trace: TraceItem[]; events: Evt[]; activeMs: number;
  firstAt: string | null; lastAt: string | null; lastReply: string; skillIds: Set<string>; toolNames: Map<string, string>;
  agentLinks: Map<string, string>; // Agent 调用 tool_use id → 子 Agent 编号
  notifications: { at: string; agentId: string; status: string; summary: string; result: string }[];
  sends: { at: string; to: string; text: string }[];
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const resultText = (c: any): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : x?.type === "image" ? "（图片）" : "")).join("\n") : "";
const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? "";

export function parseAgentFile(file: string, agentId: string): AgentModel {
  const m: AgentModel = {
    agentId, file, shapes: new Map(), msgs: new Map(), reqs: [], tools: [], prompts: [], trace: [], events: [], activeMs: 0,
    firstAt: null, lastAt: null, lastReply: "", skillIds: new Set(), toolNames: new Map(), agentLinks: new Map(), notifications: [], sends: [],
  };
  const blobs = new Map<string, any>();
  const chains = new Map<string, string[]>();
  const lastReq = new Map<string, string>();
  const reqById = new Map<string, Req>();
  const replyContent = new Map<string, any[]>(); // 请求 id → 回复的全部块
  const toolContent = new Map<string, any[]>();  // 请求 id → 回复后面跟着的工具返回块
  const toolById = new Map<string, Tool>();
  const seenMsg = new Set<string>();
  let openReq: string | null = null;
  let lastModel: string | null = null;
  let mode: string | null = null;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    const at = d.timestamp ? localTs(d.timestamp) : null;
    if (at) { if (!m.firstAt || at < m.firstAt) m.firstAt = at; if (!m.lastAt || at > m.lastAt) m.lastAt = at; }

    if (t === "api-request-shape") { m.shapes.set(d.shapeHash, d.shape); continue; }
    if (t === "api-request-blob") { blobs.set(d.hash, d.message); continue; }
    if (t === "permission-mode") {
      if (mode && d.permissionMode !== mode) m.events.push({ at: m.lastAt ?? "", kind: "mode", text: `权限模式 ${mode} → ${d.permissionMode}` });
      mode = d.permissionMode; continue;
    }
    if (t === "api-request") {
      const src = d.querySource ?? "main";
      const keys = (chains.get(src) ?? []).slice(0, d.keep ?? 0);
      let missing = 0;
      const prev = lastReq.get(src);
      for (const h of d.tail ?? []) {
        if (blobs.has(h)) { const k = `b:${h}`; if (!m.msgs.has(k)) m.msgs.set(k, blobs.get(h)); keys.push(k); continue; }
        if (missing === 0 && prev) { keys.push(`r:${prev}`); m.msgs.set(`r:${prev}`, { role: "assistant", content: replyContent.get(prev) ?? [] }); }
        else if (missing === 1 && prev) { keys.push(`t:${prev}`); m.msgs.set(`t:${prev}`, { role: "user", content: toolContent.get(prev) ?? [] }); }
        missing++;
      }
      chains.set(src, keys);
      const model = d.params?.model ?? null;
      if (lastModel && model && model !== lastModel) m.events.push({ at: at ?? "", kind: "switch", text: `模型 ${lastModel} → ${model}`, req: m.reqs.length });
      lastModel = model ?? lastModel;
      const r: Req = { idx: m.reqs.length, id: d.id, at: at ?? "", source: src, model, keys, shape: d.shapeHash ?? null,
        usage: { input: 0, read: 0, w5: 0, w1h: 0, output: 0 }, answered: false, lastAt: null, modelMs: 0, toolCalls: 0 };
      m.reqs.push(r); reqById.set(d.id, r); lastReq.set(src, d.id); openReq = d.id;
      continue;
    }
    if (t === "system") {
      if (d.subtype === "turn_duration" && d.durationMs) m.activeMs += d.durationMs;
      if (d.subtype === "compact_boundary") {
        const c = d.compactMetadata ?? {};
        const txt = `${c.trigger === "auto" ? "自动" : "手动"}压缩：${Math.round((c.preTokens ?? 0) / 1000)}k → ${Math.round((c.postTokens ?? 0) / 1000)}k`;
        m.events.push({ at: at ?? "", kind: "compact", text: txt, tokens: -((c.preTokens ?? 0) - (c.postTokens ?? 0)), req: m.reqs.length });
        m.trace.push({ at: at ?? "", kind: "event", text: txt, detail: c.durationMs ? `用时 ${Math.round(c.durationMs / 1000)} 秒` : undefined });
      }
      continue;
    }
    if (t === "assistant" && d.message?.role === "assistant") {
      const msg = d.message;
      const ref: string = d.requestRef ?? msg.id;
      let r = reqById.get(ref);
      if (!r) { // 老版本没有请求记录:用回复本身造一条
        r = { idx: m.reqs.length, id: ref, at: at ?? "", source: "legacy", model: msg.model ?? null, keys: [], shape: null,
          usage: { input: 0, read: 0, w5: 0, w1h: 0, output: 0 }, answered: false, lastAt: null, modelMs: 0, toolCalls: 0 };
        m.reqs.push(r); reqById.set(ref, r);
      }
      openReq = ref;
      (replyContent.get(ref) ?? replyContent.set(ref, []).get(ref)!).push(...(Array.isArray(msg.content) ? msg.content : []));
      const u = msg.usage;
      if (u && msg.id && !seenMsg.has(msg.id)) {
        seenMsg.add(msg.id);
        const w = u.cache_creation_input_tokens ?? 0, w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        r.usage.input += u.input_tokens ?? 0; r.usage.read += u.cache_read_input_tokens ?? 0; r.usage.w5 += w - w1h; r.usage.w1h += w1h;
        r.usage.output += u.output_tokens ?? 0; r.answered = true;
      }
      if (at && (!r.lastAt || at > r.lastAt)) { r.lastAt = at; r.modelMs = capMs(Date.parse(at.replace(" ", "T")) - Date.parse(r.at.replace(" ", "T"))); }
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c.type === "text" && c.text?.trim()) { m.trace.push({ at: at ?? "", kind: "assistant", text: c.text, req: r.idx }); m.lastReply = c.text; }
        else if (c.type === "thinking") m.trace.push({ at: at ?? "", kind: "thinking", text: c.thinking || "（思考）", req: r.idx });
        else if (c.type === "tool_use") {
          r.toolCalls++;
          m.toolNames.set(c.id, c.name);
          if (c.name === "Skill") m.skillIds.add(c.id);
          if (c.name === "SendMessage") m.sends.push({ at: at ?? "", to: String(c.input?.to ?? c.input?.recipient ?? ""), text: String(c.input?.message ?? c.input?.content ?? "") });
          const tool: Tool = { id: c.id, name: c.name, input: c.input, at: at ?? "", endAt: null, ms: null, ok: null, result: "", req: r.idx };
          m.tools.push(tool); toolById.set(c.id, tool);
        }
      }
      continue;
    }
    if (t === "user") {
      const content = d.message?.content;
      const results = Array.isArray(content) ? content.filter((c: any) => c?.type === "tool_result") : [];
      if (results.length) {
        if (openReq) (toolContent.get(openReq) ?? toolContent.set(openReq, []).get(openReq)!).push(...results);
        for (const rr of results) {
          const tool = toolById.get(rr.tool_use_id);
          if (!tool) continue;
          tool.endAt = at; tool.ok = !rr.is_error;
          tool.ms = at && tool.at ? Math.max(0, Date.parse(at.replace(" ", "T")) - Date.parse(tool.at.replace(" ", "T"))) : null;
          tool.result = clip(resultText(rr.content), 4000);
          const aid = d.toolUseResult?.agentId;
          if (tool.name === "Agent" || tool.name === "Task") { if (aid) m.agentLinks.set(tool.id, aid); }
          const shown = (tool.name === "Agent" || tool.name === "Task") && /async_launched|Async agent launched/i.test(tool.result + JSON.stringify(d.toolUseResult ?? "")) ? "已在后台启动，完成后会发通知" : clip(tool.result, 300);
          m.trace.push({ at: at ?? "", kind: "tool", name: tool.name, text: toolBrief(tool.name, tool.input), detail: shown, req: tool.req, ms: tool.ms, ok: tool.ok });
        }
        continue;
      }
      const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";
      if (raw.includes("<task-notification>")) {
        const n = { at: at ?? "", agentId: tag(raw, "task-id"), status: tag(raw, "status"), summary: tag(raw, "summary"), result: clip(tag(raw, "result"), 6000) };
        m.notifications.push(n);
        m.trace.push({ at: at ?? "", kind: "agent", text: n.summary || `后台任务 ${n.status}`, detail: clip(n.result, 300) });
        continue;
      }
      if (d.isMeta) continue;
      const p = promptText(content);
      if (p && at) { m.prompts.push({ at, text: p.text }); m.trace.push({ at, kind: "user", text: p.text }); }
    }
  }
  return m;
}

/** 会话标题:第一条真正的提问(跳过 /clear 这类斜杠命令) */
export const titleOf = (m: AgentModel) => m.prompts.find(p => !p.text.startsWith("/"))?.text ?? m.prompts[0]?.text ?? null;

export function toolBrief(name: string, input: any): string {
  if (!input) return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description ?? input.prompt ?? "";
  return clip(String(v).replace(/\s+/g, " "), 160);
}

// ---------- 每次请求的组成 ----------

const vecCache = new WeakMap<object, Record<Cat, number>>();
function msgCats(m: AgentModel, key: string): Record<Cat, number> {
  const msg = m.msgs.get(key);
  if (!msg) return Object.fromEntries(CATS.map(c => [c, 0])) as Record<Cat, number>;
  const hit = vecCache.get(msg);
  if (hit) return hit;
  const v = Object.fromEntries(CATS.map(c => [c, 0])) as Record<Cat, number>;
  for (const it of messageItems(msg, m.skillIds, m.toolNames)) v[it.cat] += it.tokens;
  vecCache.set(msg, v);
  return v;
}
const shapeCache = new WeakMap<object, Record<Cat, number>>();
function shapeCats(shape: any) {
  if (!shape) return Object.fromEntries(CATS.map(c => [c, 0])) as Record<Cat, number>;
  const hit = shapeCache.get(shape);
  if (hit) return hit;
  const v = Object.fromEntries(CATS.map(c => [c, 0])) as Record<Cat, number>;
  for (const it of shapeItems(shape)) v[it.cat] += it.tokens;
  shapeCache.set(shape, v);
  return v;
}

export const inputOf = (u: Usage) => u.input + u.read + u.w5 + u.w1h;

/** 一次请求各类的 token:先按字数估,有实际用量就等比缩放到实际输入总量 */
export function reqCats(m: AgentModel, r: Req) {
  const v = { ...shapeCats(r.shape ? m.shapes.get(r.shape) : null) };
  for (const k of r.keys) { const c = msgCats(m, k); for (const cat of CATS) v[cat] += c[cat]; }
  const estimate = CATS.reduce((s, c) => s + v[c], 0);
  const actual = inputOf(r.usage);
  const scaled = actual && estimate ? scaleTo(CATS.map(c => v[c]), actual) : CATS.map(c => v[c]);
  return { cats: Object.fromEntries(CATS.map((c, i) => [c, scaled[i]])) as Record<Cat, number>, estimate, actual, reconstructed: r.keys.length > 0 || !!r.shape };
}

/** 某次请求的上下文浏览器:按类分组的每一条,带估算 token 和原文(截断) */
export function requestBrowser(m: AgentModel, idx: number) {
  const r = m.reqs[idx];
  if (!r) return null;
  const items: (Item & { pos: number; key: string })[] = [];
  let pos = 0;
  for (const it of shapeItems(r.shape ? m.shapes.get(r.shape) : null)) items.push({ ...it, pos: pos++, key: "shape" });
  for (const k of r.keys) for (const it of messageItems(m.msgs.get(k), m.skillIds, m.toolNames)) items.push({ ...it, pos: pos++, key: k });
  const estimate = items.reduce((s, i) => s + i.tokens, 0);
  const actual = inputOf(r.usage);
  const k = actual && estimate ? actual / estimate : 1;
  // 和上一次请求比:哪些是新加的
  const prev = m.reqs[idx - 1];
  const prevKeys = new Set(prev?.keys ?? []);
  const groups = CATS.map(cat => {
    const list = items.filter(i => i.cat === cat);
    return {
      cat, count: list.length, tokens: Math.round(list.reduce((s, i) => s + i.tokens, 0) * k),
      added: list.filter(i => i.key !== "shape" && !prevKeys.has(i.key)).length,
      items: list.map(i => ({ pos: i.pos, kind: i.kind, name: i.name ?? null, tokens: Math.round(i.tokens * k), isNew: i.key !== "shape" && !prevKeys.has(i.key),
        text: clip(i.text, 3000), full: i.text.length })),
    };
  });
  return { idx, at: r.at, model: r.model, actual, estimate, scale: k, groups, total: Math.round(estimate * k) };
}

// ---------- 会话整体 ----------

function findMainFile(sid: string) {
  if (!existsSync(CC_ROOT)) return null;
  for (const dir of readdirSync(CC_ROOT)) {
    const f = join(CC_ROOT, dir, `${sid}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

export type Session = { main: AgentModel; subs: { model: AgentModel; meta: any }[] };
const cache = new Map<string, { sig: string; s: Session }>();

export function loadSession(sid: string): Session | null {
  const main = findMainFile(sid);
  if (!main) return null;
  const subDir = join(main.replace(/\.jsonl$/, ""), "subagents");
  const subFiles = existsSync(subDir) ? readdirSync(subDir).filter(f => f.endsWith(".jsonl")).map(f => join(subDir, f)) : [];
  const sig = [main, ...subFiles].map(f => `${f}:${statSync(f).size}`).join("|");
  const hit = cache.get(sid);
  if (hit && hit.sig === sig) return hit.s;
  const s: Session = {
    main: parseAgentFile(main, "main"),
    subs: subFiles.map(f => {
      const id = basename(f, ".jsonl").replace(/^agent-/, "");
      let meta: any = {};
      try { meta = JSON.parse(readFileSync(f.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch {}
      return { model: parseAgentFile(f, id), meta };
    }),
  };
  cache.set(sid, { sig, s });
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  return s;
}

const sumUsage = (rs: Req[]) => rs.reduce((a, r) => ({ input: a.input + r.usage.input, read: a.read + r.usage.read, w5: a.w5 + r.usage.w5, w1h: a.w1h + r.usage.w1h, output: a.output + r.usage.output }),
  { input: 0, read: 0, w5: 0, w1h: 0, output: 0 });
const costReqs = (rs: Req[]) => rs.reduce((s, r) => s + (costOf(r.model, r.usage) ?? 0), 0);
const billed = (u: Usage) => inputOf(u) + u.output;

/** Bash 命令的程序名:去掉 cd xx &&、环境变量赋值,取第一个词 */
export function programOf(cmd: string): string {
  let s = String(cmd ?? "").trim();
  s = s.replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "");
  // 开头的变量赋值(A=1、F="…";)、cd 到某处、准备语句(unset X; set -e; source ~/.zshrc)反复去掉,直到露出真正运行的程序
  for (let prev = ""; prev !== s;) {
    prev = s;
    s = s.replace(/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;&]*)\s*(;|&&)?\s*/, "");
    s = s.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "");
    s = s.replace(/^(unset|set|source|\.)\s+[^;&]*\s*(;|&&)\s*/, "");
  }
  const w = s.split(/\s+/)[0] ?? "";
  return basename(w.replace(/^["']|["']$/g, "")) || "（空）";
}

/** 改动的行数:Edit 按新旧字符串行数,Write 按内容行数 */
function lineDelta(name: string, input: any) {
  const lines = (s: any) => (typeof s === "string" && s ? s.split("\n").length : 0);
  if (name === "Edit") return { add: lines(input?.new_string), del: lines(input?.old_string) };
  if (name === "MultiEdit") return (input?.edits ?? []).reduce((a: any, e: any) => ({ add: a.add + lines(e.new_string), del: a.del + lines(e.old_string) }), { add: 0, del: 0 });
  if (name === "Write") return { add: lines(input?.content), del: 0 };
  return { add: 0, del: 0 };
}

export function contextView(sid: string, agent = "main") {
  const s0 = loadSession(sid);
  if (!s0) return null;
  const m = agent === "main" ? s0.main : s0.subs.find(x => x.model.agentId === agent)?.model;
  if (!m) return null;
  const s = agent === "main" ? s0 : { main: m, subs: [] };
  const reqs = m.reqs;
  const answered = reqs.filter(r => r.answered);
  const usage = sumUsage(reqs);
  const series = reqs.map(r => ({ idx: r.idx, at: r.at, model: r.model, answered: r.answered, ...reqCats(m, r), output: r.usage.output, modelMs: r.modelMs, toolCalls: r.toolCalls }));
  // Token 统计:每次请求的分类相加 + 输出
  const tokenCats = Object.fromEntries(CATS.map(c => [c, series.reduce((a, x) => a + x.cats[c], 0)])) as Record<Cat, number>;
  const last = [...series].reverse().find(x => x.answered) ?? series[series.length - 1] ?? null;
  const lastModel = last?.model ?? answered[answered.length - 1]?.model ?? null;
  const toolCount: Record<string, number> = {}, progCount: Record<string, number> = {};
  for (const t of m.tools) {
    toolCount[t.name] = (toolCount[t.name] ?? 0) + 1;
    if (t.name === "Bash") { const p = programOf(t.input?.command); progCount[p] = (progCount[p] ?? 0) + 1; }
  }
  const files = new Map<string, { path: string; read: number; write: number; search: number; add: number; del: number; ops: { at: string; op: string; req: number }[] }>();
  for (const t of m.tools) {
    const op = t.name === "Read" ? "read" : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(t.name) ? "write" : ["Glob", "Grep"].includes(t.name) ? "search" : null;
    if (!op) continue;
    const p = String(t.input?.file_path ?? t.input?.notebook_path ?? t.input?.path ?? t.input?.pattern ?? "");
    if (!p) continue;
    const f = files.get(p) ?? files.set(p, { path: p, read: 0, write: 0, search: 0, add: 0, del: 0, ops: [] }).get(p)!;
    f[op as "read" | "write" | "search"]++;
    const dl = lineDelta(t.name, t.input); f.add += dl.add; f.del += dl.del;
    f.ops.push({ at: t.at, op: t.name, req: t.req });
  }
  const images = m.tools.filter(t => t.name === "Read" && /\.(png|jpe?g|gif|webp)$/i.test(String(t.input?.file_path ?? ""))).length;
  const toolMs = m.tools.reduce((a, t) => a + (NO_TIME_TOOLS.has(t.name) ? 0 : capMs(t.ms ?? 0)), 0);
  const modelMs = reqs.reduce((a, r) => a + r.modelMs, 0);
  const active = Math.max(m.activeMs, modelMs + toolMs);
  const subCost = s.subs.reduce((a, x) => a + costReqs(x.model.reqs), 0);
  const subBilled = s.subs.reduce((a, x) => a + billed(sumUsage(x.model.reqs)), 0);
  // 注入事件:每次请求里新增的注入内容
  const injects: { at: string; kind: "inject"; text: string; tokens: number; req: number }[] = [];
  for (const r of reqs) {
    const prevKeys = new Set(reqs[r.idx - 1]?.keys ?? []);
    for (const k of r.keys) {
      if (prevKeys.has(k)) continue;
      // 每次请求都带的余量提示不逐条列,免得刷屏
      for (const it of messageItems(m.msgs.get(k), m.skillIds, m.toolNames)) if ((it.cat === "inject" || it.cat === "skill") && it.kind !== "余量提示")
        injects.push({ at: r.at, kind: "inject", text: `${it.kind}：${clip(it.text.replace(/<\/?system-reminder>/g, "").replace(/\s+/g, " ").trim(), 80)}`, tokens: it.tokens, req: r.idx });
    }
  }
  // 清理:上下文比上一次少了 15% 以上、附近又没有压缩 → Claude Code 自动清掉了旧的工具结果
  const compactReqs = new Set(m.events.filter(e => e.kind === "compact").map(e => e.req));
  const prunes: Evt[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1].actual || series[i - 1].estimate, b = series[i].actual || series[i].estimate;
    if (a > 20000 && b < a * 0.85 && !compactReqs.has(i) && !compactReqs.has(i - 1))
      prunes.push({ at: series[i].at, kind: "prune", text: `上下文清理：${Math.round(a / 1000)}k → ${Math.round(b / 1000)}k（自动清掉了较早的工具结果）`, tokens: b - a, req: i });
  }
  return {
    sid, title: titleOf(m), model: lastModel, window: windowOf(lastModel),
    stats: {
      turns: m.prompts.length, steps: reqs.length, replies: answered.length,
      skills: m.tools.filter(t => t.name === "Skill").map(t => String(t.input?.skill ?? "")),
      events: { inject: injects.length, compact: m.events.filter(e => e.kind === "compact").length, prune: prunes.length },
      io: { user: m.prompts.length, read: m.tools.filter(t => t.name === "Read").length, write: m.tools.filter(t => ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(t.name)).length,
        search: m.tools.filter(t => ["Glob", "Grep"].includes(t.name)).length, images },
      tools: Object.entries(toolCount).sort((a, b) => b[1] - a[1]), toolTotal: m.tools.length,
      programs: Object.entries(progCount).sort((a, b) => b[1] - a[1]), bashTotal: m.tools.filter(t => t.name === "Bash").length,
      fleet: { agents: s.subs.length, mainBilled: billed(usage), mainCost: costReqs(reqs), subBilled, subCost },
    },
    tokens: { cats: tokenCats, output: usage.output, billed: billed(usage), cacheHit: inputOf(usage) ? usage.read / inputOf(usage) : 0, cost: costReqs(reqs), usage },
    timing: { activeMs: active, modelMs, toolMs, otherMs: Math.max(0, active - modelMs - toolMs), modelCalls: answered.length, toolCalls: m.tools.length,
      speed: modelMs ? usage.output / (modelMs / 1000) : 0,
      bands: reqs.map(r => ({ at: r.at, modelMs: r.modelMs })).slice(-400) },
    current: last ? { idx: last.idx, at: last.at, cats: last.cats, total: last.actual || last.estimate, estimated: !last.actual } : null,
    trend: series.map(x => ({ idx: x.idx, at: x.at, cats: x.cats, total: x.actual || x.estimate, output: x.output, modelMs: x.modelMs, reconstructed: x.reconstructed })),
    events: [...m.events, ...injects, ...prunes].sort((a, b) => a.at.localeCompare(b.at)),
    files: [...files.values()].sort((a, b) => b.ops.length - a.ops.length).slice(0, 300),
    commands: m.tools.filter(t => t.name === "Bash").map(t => ({ at: t.at, cmd: String(t.input?.command ?? ""), desc: String(t.input?.description ?? ""), program: programOf(t.input?.command),
      ms: t.ms, ok: t.ok, req: t.req, result: clip(t.result, 600), background: !!t.input?.run_in_background })).reverse(),
  };
}

export function traceView(sid: string, agent = "main") {
  const m = agentModelOf(sid, agent);
  if (!m) return null;
  const bands = m.reqs.map(r => ({ at: r.at, end: r.lastAt, kind: "model" as const }))
    .concat(m.tools.filter(t => t.endAt).map(t => ({ at: t.at, end: t.endAt, kind: "tool" as const })) as any)
    .concat(m.prompts.map(p => ({ at: p.at, end: p.at, kind: "user" as const })) as any);
  return { sid, items: m.trace.map(x => ({ ...x, text: clip(x.text, 1500), detail: x.detail ? clip(x.detail, 600) : undefined })), bands, start: m.firstAt, end: m.lastAt };
}

export function fleetView(sid: string) {
  const s = loadSession(sid);
  if (!s) return null;
  const m = s.main;
  const agentTool = new Map<string, any>(); // 子 Agent 编号 → 派它的那次调用
  for (const t of m.tools) if (t.name === "Agent" || t.name === "Task") { const id = m.agentLinks.get(t.id); if (id) agentTool.set(id, t); }
  const card = (am: AgentModel, meta: any, tool: any, role: "主控" | "子 Agent") => {
    const u = sumUsage(am.reqs);
    const lastAns = [...am.reqs].reverse().find(r => r.answered);
    const ctx = lastAns ? inputOf(lastAns.usage) : 0;
    const model = lastAns?.model ?? am.reqs[am.reqs.length - 1]?.model ?? null;
    const note = m.notifications.find(n => n.agentId === am.agentId);
    const running = role === "子 Agent" && !meta?.finished && !note && !(tool && tool.endAt && !tool.input?.run_in_background);
    const status = role === "主控" ? "主控" : running ? "运行中" : note?.status === "failed" || tool?.ok === false ? "失败" : "已完成";
    const cats = lastAns ? reqCats(am, lastAns).cats : null;
    return {
      id: am.agentId, role, title: role === "主控" ? (titleOf(m) ?? "主会话") : (meta?.description ?? tool?.input?.description ?? am.agentId),
      type: meta?.agentType ?? tool?.input?.subagent_type ?? null, background: !!(meta?.requestShape === "background" || tool?.input?.run_in_background),
      status, model, steps: am.reqs.length, durMs: am.firstAt && am.lastAt ? Date.parse(am.lastAt.replace(" ", "T")) - Date.parse(am.firstAt.replace(" ", "T")) : 0,
      billed: billed(u), cost: costReqs(am.reqs), ctx, ctxPct: ctx / windowOf(model), cats, lastReply: clip(am.lastReply.replace(/\s+/g, " "), 200),
      startAt: am.firstAt, prompt: tool ? clip(String(tool.input?.prompt ?? ""), 4000) : null,
    };
  };
  const main = card(m, null, null, "主控");
  const subs = s.subs.map(x => card(x.model, x.meta, agentTool.get(x.model.agentId), "子 Agent")).sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
  // 通讯:去程(派活说明)、回程(完成通知 / 同步结果)、发消息
  const comms: { at: string; dir: "去" | "回" | "发"; agent: string; title: string; kind: string; text: string; status?: string }[] = [];
  for (const sub of subs) {
    const t = agentTool.get(sub.id);
    if (t) comms.push({ at: t.at, dir: "去", agent: sub.id, title: sub.title, kind: "派活", text: String(t.input?.prompt ?? "") });
    const note = m.notifications.find(n => n.agentId === sub.id);
    if (note) comms.push({ at: note.at, dir: "回", agent: sub.id, title: sub.title, kind: "完成通知", status: note.status, text: note.result || note.summary });
    else if (t?.endAt && !t.input?.run_in_background && !/async_launched/.test(t.result)) comms.push({ at: t.endAt, dir: "回", agent: sub.id, title: sub.title, kind: "回报", status: t.ok ? "completed" : "failed", text: t.result });
  }
  for (const x of m.sends) comms.push({ at: x.at, dir: "发", agent: x.to, title: x.to, kind: "消息", text: x.text });
  comms.sort((a, b) => a.at.localeCompare(b.at));
  const tasks = subs.map(sub => ({ id: sub.id, title: sub.title, status: sub.status, prompt: sub.prompt, durMs: sub.durMs, steps: sub.steps, type: sub.type, background: sub.background }));
  return {
    sid, main, subs, tasks, comms: comms.map(c => ({ ...c, text: clip(c.text, 6000) })),
    summary: {
      agents: subs.length + 1, running: subs.filter(x => x.status === "运行中").length, done: subs.filter(x => x.status === "已完成").length,
      failed: subs.filter(x => x.status === "失败").length, ctxTotal: main.ctx + subs.reduce((a, x) => a + x.ctx, 0),
      cost: main.cost + subs.reduce((a, x) => a + x.cost, 0), billed: main.billed + subs.reduce((a, x) => a + x.billed, 0),
    },
  };
}

/** 子 Agent 的上下文:复用主会话的视图结构 */
export function agentModelOf(sid: string, agentId: string) {
  const s = loadSession(sid);
  if (!s) return null;
  return agentId === "main" ? s.main : s.subs.find(x => x.model.agentId === agentId)?.model ?? null;
}
export { est };

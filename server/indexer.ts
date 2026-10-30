/**
 * Claude Code 会话增量索引
 * 每个 jsonl 记住读到哪个字节,下次只读新追加的部分;消息链的中间状态存在 cc_files.state 里,接着往下算。
 * 子 Agent 的日志(<会话>/subagents/*.jsonl)用量算进父会话,请求记录标上 agent。
 *
 * 每次请求的上下文 = 上一次同来源请求的前 keep 条消息 + 这次 tail 里的消息(api-request)。
 * tail 里有存档的消息在 api-request-blob 里;没存档的(排在前面)= 上一次请求得到的回复 + 紧跟其后的工具返回。
 * 同一条回复会拆成多行写(思考、文字、工具调用各一行),每行都带同一份 usage → 按 message.id 只算一次。
 *
 * 不是所有 Claude Code 都写 api-request。没有的话从对话本身还原:上次压缩以来的每条消息、回复、工具返回、
 * 注入的附件(attachment)按顺序累加,每来一条新回复就把累计值记成这次请求的上下文;
 * 系统提示词和工具定义取最近的 prompt_snapshot 附件;连快照也没有就记成「系统与工具(合计)」,
 * 取第一次请求的「实际输入 − 对话部分」(一个会话里基本不变)。
 */
import { Database } from "bun:sqlite";
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { messageVec, shapeVec, attachmentVec, snapshotShape, zero, addVec, capMs, NO_TIME_TOOLS, MAX_CALL_MS, type Vec } from "./classify";

export const CC_SCHEMA = `
CREATE TABLE IF NOT EXISTS cc_files (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, offset INTEGER, session_id TEXT);
CREATE TABLE IF NOT EXISTS cc_sessions (
  id TEXT PRIMARY KEY, dir TEXT, cwd TEXT, first_at TEXT, last_at TEXT, title TEXT, last_prompt TEXT,
  prompts INTEGER DEFAULT 0, replies INTEGER DEFAULT 0, out_tokens INTEGER DEFAULT 0, in_tokens INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, model TEXT, subagents INTEGER DEFAULT 0, branch TEXT,
  auto INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cc_skills (session_id TEXT, at TEXT, skill TEXT, via TEXT);
CREATE TABLE IF NOT EXISTS cc_prompts (session_id TEXT, at TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS cc_prompts_s ON cc_prompts (session_id);
CREATE INDEX IF NOT EXISTS cc_skills_at ON cc_skills (at);
CREATE TABLE IF NOT EXISTS cc_requests (
  id TEXT PRIMARY KEY, session_id TEXT, agent TEXT, at TEXT, day TEXT, source TEXT, model TEXT,
  input INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, w5 INTEGER DEFAULT 0, w1h INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
  e_system INTEGER DEFAULT 0, e_tools INTEGER DEFAULT 0, e_base INTEGER DEFAULT 0, e_user INTEGER DEFAULT 0, e_inject INTEGER DEFAULT 0, e_skill INTEGER DEFAULT 0,
  e_assistant INTEGER DEFAULT 0, e_tool INTEGER DEFAULT 0, msgs INTEGER DEFAULT 0, last_at TEXT, model_ms INTEGER DEFAULT 0,
  tool_ms INTEGER DEFAULT 0, tool_calls INTEGER DEFAULT 0, answered INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cc_requests_s ON cc_requests (session_id, at);
CREATE INDEX IF NOT EXISTS cc_requests_d ON cc_requests (day);
CREATE TABLE IF NOT EXISTS cc_meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** 建表 + 给老库补列(索引线程和网页线程都要调,谁先跑都行) */
export function ensureSchema(db: Database) {
  db.exec(CC_SCHEMA);
  try { db.exec("ALTER TABLE cc_files ADD COLUMN state TEXT"); } catch {}
  try { db.exec("ALTER TABLE cc_sessions ADD COLUMN auto INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE cc_requests ADD COLUMN e_base INTEGER DEFAULT 0"); } catch {}
}

/** 索引格式版本:改了解析口径就加一,启动时发现旧版本会清空重建 */
export const CC_VERSION = "9";

const SKIP_PREFIX = ['{"type":"mode"', '{"type":"permission-mode"', '{"type":"atis-latch"', '{"type":"file-history', '{"type":"queue-operation"'];

/** 本地日期(按本机时区),时间戳是 UTC ISO */
export const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const localTs = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDay(iso)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 用户真正输入的话:去掉系统注入、命令外壳;斜杠命令记成「/命令 参数」 */
export function promptText(content: unknown): { text: string; command?: string } | null {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    s = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
  }
  s = s.trim();
  if (!s) return null;
  const cmd = s.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmd) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
    return { text: `/${cmd[1].trim()}${args ? " " + args : ""}`, command: cmd[1].trim() };
  }
  if (/^<(local-command|system-reminder|task-notification|bash-|user-memory)/.test(s)) return null;
  if (s.startsWith("Caveat:") || s.startsWith("[Request interrupted") || s.startsWith("Another Claude session sent a message")) return null;
  return { text: s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() };
}

/** 跨增量批次要接着用的状态 */
type State = {
  chains: Record<string, Vec[]>; shapes: Record<string, [number, number]>; blobs: Record<string, Vec>;
  lastReq: Record<string, string>; pendReply: Record<string, Vec>; pendTools: Vec; skillIds: string[];
  lastMsgId: string | null; toolStart: Record<string, [string, string]>; // tool_use id → [时间, 所属请求]
  // 没有 api-request 时从对话还原:api = 这个文件里见过 api-request;tvec = 上次压缩以来累计的消息;tsys = 最近快照的系统提示词/工具定义
  api: boolean; tvec: Vec; tsys: [number, number] | null; lastUserTs: string | null; base: number | null;
};
const newState = (): State => ({ chains: {}, shapes: {}, blobs: {}, lastReq: {}, pendReply: {}, pendTools: zero(), skillIds: [], lastMsgId: null, toolStart: {},
  api: false, tvec: zero(), tsys: null, lastUserTs: null, base: null });

type ReqRow = { id: string; at: string; source: string; model: string | null; e: number[]; msgs: number };
type ReqUpd = { model: string | null; input: number; read: number; w5: number; w1h: number; output: number; lastAt: string | null; toolMs: number; toolCalls: number; answered: number };

type Acc = {
  state: State; agent: string | null; reqs: ReqRow[]; upd: Map<string, ReqUpd>;
  sid: string; dir: string; cwd?: string; entry?: string; first?: string; last?: string; title?: string; lastPrompt?: string; branch?: string;
  prompts: number; replies: number; out: number; inp: number; cr: number; cw: number; model?: string; sub: boolean;
  skills: [string, string, string][]; said: [string, string][];
};

const updOf = (a: Acc, ref: string) => {
  let u = a.upd.get(ref);
  if (!u) { u = { model: null, input: 0, read: 0, w5: 0, w1h: 0, output: 0, lastAt: null, toolMs: 0, toolCalls: 0, answered: 0 }; a.upd.set(ref, u); }
  return u;
};

function parseLines(text: string, acc: Acc) {
  const st = acc.state;
  const skillIds = new Set(st.skillIds);
  for (const line of text.split("\n")) {
    if (!line || SKIP_PREFIX.some(p => line.startsWith(p))) continue;
    // 有请求记录时附件已经包含在请求里,跳过省时间;没有时附件是上下文的一部分
    if (st.api && line.slice(0, 400).includes('"attachment":{')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;

    if (t === "api-request-shape") { st.shapes[d.shapeHash] = shapeVec(d.shape); continue; }
    if (t === "api-request-blob") { st.blobs[d.hash] = messageVec(d.message, skillIds); continue; }
    if (t === "api-request") {
      st.api = true;
      const src = d.querySource ?? "main";
      const chain = (st.chains[src] ?? []).slice(0, d.keep ?? 0);
      // 没存档的条目:老格式是「上一次的回复、紧跟其后的工具返回」都没存档;新格式回复存了档,只有工具返回没存。
      // 所以补缺时看这段 tail 里有没有回复:还没有就补回复,有了就补工具返回。(助手消息只含 assistant 类,下标 3)
      let replyIn = false, toolsIn = false;
      for (const h of d.tail ?? []) {
        const b = st.blobs[h];
        if (b) { chain.push(b); if (b[3] > 0 && b.every((x, i) => i === 3 || x === 0)) replyIn = true; delete st.blobs[h]; continue; }
        if (!replyIn) { const prev = st.lastReq[src]; chain.push(prev ? st.pendReply[prev] ?? zero() : zero()); if (prev) delete st.pendReply[prev]; replyIn = true; }
        else if (!toolsIn) { chain.push(st.pendTools); toolsIn = true; }
        else chain.push(zero());
      }
      st.pendTools = zero();
      st.chains[src] = chain;
      const sum = chain.reduce(addVec, zero());
      const sh = st.shapes[d.shapeHash] ?? [0, 0];
      acc.reqs.push({ id: d.id, at: d.timestamp, source: src, model: d.params?.model ?? null, e: [sh[0], sh[1], 0, ...sum], msgs: chain.length });
      st.lastReq[src] = d.id;
      continue;
    }

    if (t === "last-prompt" && typeof d.lastPrompt === "string") { acc.lastPrompt = d.lastPrompt.slice(0, 300); continue; }
    const ts: string | undefined = d.timestamp;
    if (ts) { if (!acc.first || ts < acc.first) acc.first = ts; if (!acc.last || ts > acc.last) acc.last = ts; }
    if (d.cwd && !acc.cwd) acc.cwd = d.cwd;
    if (d.gitBranch) acc.branch = d.gitBranch;
    if (d.entrypoint && !acc.entry) acc.entry = d.entrypoint;
    // 子 Agent 文件里每行都是 sidechain;主文件里的 sidechain 是老版本内联的子任务,不在主对话上下文里
    const inChain = !st.api && (acc.sub || !d.isSidechain);

    if (t === "attachment") {
      const a = d.attachment;
      if (!inChain || !a) continue;
      if (a.type === "prompt_snapshot") {
        const [sys, tools] = shapeVec(snapshotShape(a));
        st.tsys = [sys || st.tsys?.[0] || 0, Array.isArray(a.tools) ? tools : st.tsys?.[1] ?? 0];
      } else st.tvec = addVec(st.tvec, attachmentVec(a));
      continue;
    }
    if (t === "system") { if (d.subtype === "compact_boundary" && inChain) st.tvec = zero(); continue; }

    if (t === "user") {
      if (inChain) { st.tvec = addVec(st.tvec, messageVec(d.message, skillIds)); if (ts) st.lastUserTs = ts; }
      const content = d.message?.content;
      const results = Array.isArray(content) ? content.filter((c: any) => c?.type === "tool_result") : [];
      if (results.length) {
        // 工具返回:进下一次请求的上下文;顺便算工具执行时长
        st.pendTools = addVec(st.pendTools, messageVec(d.message, skillIds));
        for (const r of results) {
          const s0 = st.toolStart[r.tool_use_id];
          if (s0 && ts) { const u = updOf(acc, s0[1]); u.toolMs += capMs(Date.parse(ts) - Date.parse(s0[0])); delete st.toolStart[r.tool_use_id]; }
        }
        continue;
      }
      if (d.isMeta || acc.sub || !ts) continue;
      const p = promptText(content);
      if (!p) continue;
      acc.prompts++;
      if (!acc.title && !p.command) acc.title = p.text.slice(0, 120);
      acc.said.push([ts, p.text.slice(0, 600)]);
      if (p.command) acc.skills.push([ts, p.command, "命令"]);
    } else if (t === "assistant" && d.message?.role === "assistant") {
      const m = d.message;
      // 老版本 Claude Code 不记录请求,回复上也没有 requestRef → 用回复自己的 id 当请求编号,用量照样能算
      const ref: string | undefined = d.requestRef ?? m.id;
      if (m.model && m.model !== "<synthetic>") { acc.model = m.model; if (ref) updOf(acc, ref).model = m.model; }
      // 回复内容(每行是不同的块)累计到这次请求名下,下一次请求把它当成「没存档的回复」用
      if (ref) st.pendReply[ref] = addVec(st.pendReply[ref] ?? zero(), messageVec(m, skillIds));
      const u = m.usage;
      if (inChain && ref && u && ts && m.id !== st.lastMsgId) {
        // 没有请求记录:这次请求的上下文 = 到这条回复之前累计的全部
        const actual = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const msgSum = st.tvec.reduce((a, b) => a + b, 0);
        // 没有快照:系统提示词和工具定义在一个会话里基本不变,取第一次请求的「实际输入 − 对话部分」当合计,后面沿用
        // (越往后对话越长,估算误差越大,不能每次都拿余数)
        if (!st.tsys && st.base === null) st.base = Math.max(0, actual - msgSum);
        const head = st.tsys ? [st.tsys[0], st.tsys[1], 0] : [0, 0, st.base ?? 0];
        acc.reqs.push({ id: ref, at: st.lastUserTs ?? ts, source: "transcript", model: m.model ?? null, e: [...head, ...st.tvec], msgs: 0 });
      }
      if (inChain) st.tvec = addVec(st.tvec, messageVec(m, skillIds));
      if (u && ts && m.id !== st.lastMsgId) {
        st.lastMsgId = m.id ?? null;
        acc.replies++;
        const o = u.output_tokens ?? 0, i = u.input_tokens ?? 0, r = u.cache_read_input_tokens ?? 0, w = u.cache_creation_input_tokens ?? 0;
        acc.out += o; acc.inp += i; acc.cr += r; acc.cw += w;
        if (ref) {
          const q = updOf(acc, ref);
          q.input += i; q.read += r; q.output += o; q.answered = 1;
          const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          q.w1h += w1h; q.w5 += w - w1h;
        }
      }
      if (ref && ts) { const q = updOf(acc, ref); if (!q.lastAt || ts > q.lastAt) q.lastAt = ts; }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== "tool_use") continue;
        if (ref && ts) { if (!NO_TIME_TOOLS.has(c.name)) st.toolStart[c.id] = [ts, ref]; updOf(acc, ref).toolCalls++; }
        if (c.name === "Skill") { skillIds.add(c.id); if (c.input?.skill && ts) acc.skills.push([ts, String(c.input.skill), "技能"]); }
      }
    }
  }
  st.skillIds = [...skillIds].slice(-500);
  // 状态别无限长:没被消费的存档和回复只留最近的
  const trim = (o: Record<string, unknown>, n: number) => { const k = Object.keys(o); for (const x of k.slice(0, Math.max(0, k.length - n))) delete o[x]; };
  trim(st.blobs, 200); trim(st.pendReply, 20); trim(st.toolStart, 200);
}

/** 从 offset 读到最后一个完整行,分块读,大文件不一次进内存 */
function readNew(path: string, offset: number, size: number, onChunk: (s: string) => void) {
  const fd = openSync(path, "r");
  const CH = 8 * 1024 * 1024;
  let pos = offset, carry = Buffer.alloc(0);
  try {
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CH, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const all = Buffer.concat([carry, buf.subarray(0, n)]);
      const cut = all.lastIndexOf(10);
      if (cut < 0) { carry = all; continue; }
      onChunk(all.subarray(0, cut).toString("utf8"));
      carry = all.subarray(cut + 1);
    }
  } finally { closeSync(fd); }
  return pos - carry.length; // 不完整的最后一行留到下次
}

function listFiles(root: string) {
  const out: { path: string; dir: string; sid: string; sub: boolean }[] = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f.endsWith(".jsonl")) out.push({ path: p, dir, sid: basename(f, ".jsonl"), sub: false });
      else if (statSync(p).isDirectory() && existsSync(join(p, "subagents")))
        for (const s of readdirSync(join(p, "subagents"))) if (s.endsWith(".jsonl")) out.push({ path: join(p, "subagents", s), dir, sid: f, sub: true });
    }
  }
  return out;
}

export function indexAll(db: Database, root: string, log = (_: string) => {}) {
  ensureSchema(db);
  const ver = (db.query("SELECT value FROM cc_meta WHERE key = 'version'").get() as { value: string } | null)?.value;
  if (ver !== CC_VERSION) {
    for (const t of ["cc_files", "cc_sessions", "cc_skills", "cc_prompts", "cc_requests"]) db.exec(`DELETE FROM ${t}`);
    db.query("INSERT OR REPLACE INTO cc_meta (key, value) VALUES ('version', ?)").run(CC_VERSION);
    log(`会话索引格式升级到 ${CC_VERSION}，全部重建`);
  }
  const getFile = db.query("SELECT size, mtime, offset, state FROM cc_files WHERE path = ?");
  let changed = 0, bytes = 0;
  for (const f of listFiles(root)) {
    const st = statSync(f.path);
    const prev = getFile.get(f.path) as { size: number; mtime: number; offset: number; state: string | null } | null;
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    let offset = prev?.offset ?? 0;
    if (prev && st.size < prev.offset) { purgeSession(db, f.sid); offset = 0; } // 文件被改写过,整个会话重建
    let state = newState();
    if (offset > 0 && prev?.state) { try { state = { ...newState(), ...JSON.parse(prev.state) }; } catch {} }
    const acc: Acc = { state, agent: f.sub ? basename(f.path, ".jsonl") : null, reqs: [], upd: new Map(),
      sid: f.sid, dir: f.dir, prompts: 0, replies: 0, out: 0, inp: 0, cr: 0, cw: 0, sub: f.sub,
      skills: [], said: [] };
    const end = readNew(f.path, offset, st.size, s => parseLines(s, acc));
    bytes += end - offset;
    save(db, acc, f.path, st.size, st.mtimeMs, end);
    changed++;
  }
  log(`会话索引：更新 ${changed} 个文件，读 ${(bytes / 1048576).toFixed(1)} MB`);
  return { changed, bytes };
}

function purgeSession(db: Database, sid: string) {
  for (const t of ["cc_skills", "cc_prompts", "cc_requests"]) db.query(`DELETE FROM ${t} WHERE session_id = ?`).run(sid);
  db.query("DELETE FROM cc_sessions WHERE id = ?").run(sid);
  db.query("DELETE FROM cc_files WHERE session_id = ?").run(sid);
}

function save(db: Database, a: Acc, path: string, size: number, mtime: number, offset: number) {
  db.transaction(() => {
    db.query(`INSERT INTO cc_sessions (id, dir, cwd, first_at, last_at, title, last_prompt, prompts, replies, out_tokens, in_tokens, cache_read, cache_write, model, subagents, branch, auto)
      VALUES ($id, $dir, $cwd, $first, $last, $title, $lp, $prompts, $replies, $out, $inp, $cr, $cw, $model, $sub, $branch, COALESCE($auto, 0))
      ON CONFLICT(id) DO UPDATE SET
        cwd = COALESCE(cc_sessions.cwd, excluded.cwd),
        first_at = CASE WHEN cc_sessions.first_at IS NULL OR (excluded.first_at IS NOT NULL AND excluded.first_at < cc_sessions.first_at) THEN excluded.first_at ELSE cc_sessions.first_at END,
        last_at = CASE WHEN cc_sessions.last_at IS NULL OR (excluded.last_at IS NOT NULL AND excluded.last_at > cc_sessions.last_at) THEN excluded.last_at ELSE cc_sessions.last_at END,
        title = COALESCE(cc_sessions.title, excluded.title),
        last_prompt = COALESCE(excluded.last_prompt, cc_sessions.last_prompt),
        prompts = cc_sessions.prompts + excluded.prompts, replies = cc_sessions.replies + excluded.replies,
        out_tokens = cc_sessions.out_tokens + excluded.out_tokens, in_tokens = cc_sessions.in_tokens + excluded.in_tokens,
        cache_read = cc_sessions.cache_read + excluded.cache_read, cache_write = cc_sessions.cache_write + excluded.cache_write,
        model = COALESCE(excluded.model, cc_sessions.model), subagents = cc_sessions.subagents + excluded.subagents,
        branch = COALESCE(excluded.branch, cc_sessions.branch),
        auto = CASE WHEN $sub = 1 OR $auto IS NULL THEN cc_sessions.auto ELSE $auto END`).run({
      $id: a.sid, $dir: a.dir, $cwd: a.sub ? null : a.cwd ?? null, $first: a.first ? localTs(a.first) : null, $last: a.last ? localTs(a.last) : null,
      $title: a.title ?? null, $lp: a.lastPrompt ?? null, $prompts: a.prompts, $replies: a.replies, $out: a.out, $inp: a.inp, $cr: a.cr, $cw: a.cw,
      $model: a.model ?? null, $sub: a.sub && !(db.query("SELECT 1 FROM cc_files WHERE path = ?").get(path)) ? 1 : 0, $branch: a.branch ?? null,
      // 脚本用 claude -p 起的会话入口是 sdk-cli,自己在终端开的是 cli
      $auto: a.sub || !a.entry ? null : a.entry === "sdk-cli" ? 1 : 0,
    });
    const sq = db.query("INSERT INTO cc_skills (session_id, at, skill, via) VALUES (?, ?, ?, ?)");
    for (const [at, s, via] of a.skills) sq.run(a.sid, localTs(at), s, via);
    const pq = db.query("INSERT INTO cc_prompts (session_id, at, text) VALUES (?, ?, ?)");
    for (const [at, t] of a.said) pq.run(a.sid, localTs(at), t);
    const rq = db.query(`INSERT OR IGNORE INTO cc_requests (id, session_id, agent, at, day, source, model, e_system, e_tools, e_base, e_user, e_inject, e_skill, e_assistant, e_tool, msgs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of a.reqs) rq.run(r.id, a.sid, a.agent, localTs(r.at), localDay(r.at), r.source, r.model, ...r.e.map(x => Math.round(x)), r.msgs);
    const uq = db.query(`UPDATE cc_requests SET input = input + $i, cache_read = cache_read + $r, w5 = w5 + $w5, w1h = w1h + $w1h, output = output + $o,
      tool_ms = tool_ms + $tm, tool_calls = tool_calls + $tc, answered = MAX(answered, $an),
      last_at = CASE WHEN $la IS NOT NULL AND (last_at IS NULL OR $la > last_at) THEN $la ELSE last_at END,
      model_ms = CASE WHEN $la IS NOT NULL THEN MAX(model_ms, MIN(${MAX_CALL_MS}, CAST((julianday($la) - julianday(at)) * 86400000 AS INTEGER))) ELSE model_ms END
      WHERE id = $id`);
    // 挂不上请求记录的用量(老会话没有 api-request)补一条只有用量的请求,保证全局总数对得上
    const lq = db.query(`INSERT OR IGNORE INTO cc_requests (id, session_id, agent, at, day, source, model) VALUES (?, ?, ?, ?, ?, 'legacy', ?)`);
    for (const [id, u] of a.upd) if (u.lastAt) lq.run(id, a.sid, a.agent, localTs(u.lastAt), localDay(u.lastAt), u.model);
    for (const [id, u] of a.upd) uq.run({ $i: u.input, $r: u.read, $w5: u.w5, $w1h: u.w1h, $o: u.output, $tm: u.toolMs, $tc: u.toolCalls, $an: u.answered, $la: u.lastAt ? localTs(u.lastAt) : null, $id: id });
    db.query(`INSERT INTO cc_files (path, size, mtime, offset, session_id, state) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, state = excluded.state`).run(path, size, mtime, offset, a.sid, JSON.stringify(a.state));
  })();
}

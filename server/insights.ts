/**
 * 全局上下文洞察:按时间范围汇总请求级索引
 * 组成按每次请求「估算各类 × 实际输入 / 估算合计」缩放后相加;没法还原的老请求单独算「未拆分」
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { db } from "./db";
import { HOME } from "./paths";
import { daysAgo, today } from "./time";
import { costOf, CATS } from "./classify";
import { ensureSchema } from "./indexer";
import { labelsOf, pinnedSessions } from "./labels";

ensureSchema(db);
export type Range = "today" | "7d" | "30d" | "all";
/**
 * 按模型系列筛选:Claude Code 也能经网关跑别家模型(DeepSeek 等),请求里记着真实模型名。
 * 没有模型名的(本地合成的提示、老日志)只算在「全部」里。
 */
export type Fam = "all" | "claude" | "deepseek" | "other";
const IS_CLAUDE = "(model LIKE 'claude%' OR model LIKE '%opus%' OR model LIKE '%sonnet%' OR model LIKE '%haiku%' OR model LIKE '%fable%' OR model LIKE '%mythos%')";
const IS_DS = "model LIKE 'deepseek%'";
const HAS = "(model IS NOT NULL AND model != '' AND model NOT LIKE '<%')";
export const famSql = (f: Fam) => f === "claude" ? IS_CLAUDE : f === "deepseek" ? IS_DS : f === "other" ? `(${HAS} AND NOT ${IS_CLAUDE} AND NOT ${IS_DS})` : "1=1";
export const famOf = (model: string | null) => !model || model.startsWith("<") ? null
  : /claude|opus|sonnet|haiku|fable|mythos/i.test(model) ? "claude" : /^deepseek/i.test(model) ? "deepseek" : "other";
export const fromOf = (r: Range) => r === "today" ? today() : r === "7d" ? daysAgo(6) : r === "30d" ? daysAgo(29) : "0000";
const EST = CATS.map(c => `e_${c}`).join(" + ");
const ACT = "(input + cache_read + w5 + w1h)";

/** 会话在哪个目录下启动:显示目录名;在家目录启动的显示 ~ */
export function whereOf(cwd: string | null, dir: string) {
  if (cwd) return cwd === HOME ? "~" : basename(cwd) || cwd;
  return dir.replace(/^-/, "").split("-").pop() || dir;
}

function costBy(where: string, args: any[]) {
  const rows = db.query(`SELECT model, sum(input) input, sum(cache_read) read, sum(w5) w5, sum(w1h) w1h, sum(output) output FROM cc_requests WHERE ${where} GROUP BY model`).all(...args) as any[];
  return rows.reduce((s, r) => s + (costOf(r.model, r) ?? 0), 0);
}

/** 已安装的技能名(本机 ~/.claude/skills + 插件里的技能),用来把内置斜杠命令和技能分开 */
let skillCache: { at: number; names: Set<string> } | null = null;
function skillNames() {
  if (skillCache && Date.now() - skillCache.at < 60000) return skillCache.names;
  const names = new Set<string>();
  const local = join(HOME, ".claude/skills");
  if (existsSync(local)) for (const d of readdirSync(local)) names.add(d);
  try {
    const inst = JSON.parse(readFileSync(join(HOME, ".claude/plugins/installed_plugins.json"), "utf8")).plugins ?? {};
    for (const [key, arr] of Object.entries<any>(inst)) {
      const p = Array.isArray(arr) ? arr[0]?.installPath : arr?.installPath;
      const dir = p && join(p, "skills");
      if (dir && existsSync(dir)) for (const d of readdirSync(dir)) { names.add(d); names.add(`${key.split("@")[0]}:${d}`); }
    }
  } catch {}
  skillCache = { at: Date.now(), names };
  return names;
}

/** 按模型分:每个模型在这段时间里的会话数、token、费用(不受筛选影响) */
function byModel(from: string) {
  const rows = db.query(`SELECT model, count(DISTINCT session_id) sessions, sum(${ACT} + output) billed, sum(input) input, sum(cache_read) read, sum(w5) w5, sum(w1h) w1h, sum(output) output
    FROM cc_requests WHERE day >= ? AND ${HAS} GROUP BY model ORDER BY billed DESC`).all(from) as any[];
  const models = rows.map(r => ({ model: r.model, fam: famOf(r.model), sessions: r.sessions, billed: r.billed ?? 0, cost: costOf(r.model, r) }));
  const fams = (["claude", "deepseek", "other"] as const).map(f => {
    const ms = models.filter(m => m.fam === f);
    const n = (db.query(`SELECT count(DISTINCT session_id) n FROM cc_requests WHERE day >= ? AND ${famSql(f)}`).get(from) as any).n;
    return { fam: f, sessions: n, billed: ms.reduce((s, m) => s + m.billed, 0), cost: ms.reduce((s, m) => s + (m.cost ?? 0), 0), priced: ms.every(m => m.cost != null) };
  });
  return { fams, models };
}

export function insights(range: Range, q = "", fam: Fam = "all") {
  const from = fromOf(range);
  const F = famSql(fam);
  const W = `day >= ? AND ${F}`;
  const k = db.query(`SELECT count(DISTINCT session_id) sessions, sum(${ACT} + output) billed, sum(${ACT}) inp, sum(cache_read) read, sum(output) output,
    sum(answered) calls, sum(tool_calls) tools, sum(tool_ms) tool_ms, sum(model_ms) model_ms FROM cc_requests WHERE ${W}`).get(from) as any;
  const comp = db.query(`SELECT ${CATS.map(c => `sum(CASE WHEN (${EST}) > 0 THEN e_${c} * 1.0 * ${ACT} / (${EST}) ELSE 0 END) ${c}`).join(", ")},
    sum(CASE WHEN (${EST}) = 0 THEN ${ACT} ELSE 0 END) unsplit FROM cc_requests WHERE ${W}`).get(from) as any;
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = daysAgo(i);
    const t = db.query(`SELECT sum(${ACT} + output) billed FROM cc_requests WHERE day = ? AND ${F}`).get(day) as any;
    week.push({ day, billed: t?.billed ?? 0, cost: costBy(`day = ? AND ${F}`, [day]) });
  }
  const heat = db.query(`SELECT day, sum(${ACT} + output) billed, count(DISTINCT session_id) sessions FROM cc_requests WHERE day >= ? AND ${F} GROUP BY day`).all(daysAgo(55));
  const names = skillNames();
  const skills = (db.query(`SELECT skill, count(*) n, max(at) last FROM cc_skills WHERE at >= ?${fam === "all" ? "" : ` AND session_id IN (SELECT session_id FROM cc_requests WHERE ${F})`} GROUP BY skill ORDER BY n DESC`).all(from) as any[]).filter(s => names.has(s.skill));
  const ss = db.query(`SELECT s.*, x.billed, x.steps FROM cc_sessions s JOIN (
      SELECT session_id, sum(${ACT} + output) billed, count(*) steps FROM cc_requests WHERE ${W} GROUP BY session_id
    ) x ON x.session_id = s.id LEFT JOIN cc_labels l ON l.session_id = s.id
    ${q ? "WHERE s.title LIKE ? OR s.last_prompt LIKE ? OR l.name LIKE ?" : ""} ORDER BY s.last_at DESC LIMIT 300`)
    .all(from, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])) as any[];
  const labels = labelsOf(ss.map(s => s.id));
  const cards = ss.map(s => {
    const last = db.query(`SELECT *, ${ACT} actual, (${EST}) est FROM cc_requests WHERE session_id = ? AND agent IS NULL AND answered = 1 ORDER BY at DESC LIMIT 1`).get(s.id) as any;
    return {
      id: s.id, title: s.title, name: labels.get(s.id)?.name ?? null, pinned: !!labels.get(s.id)?.pinnedAt, lastPrompt: s.last_prompt, lastAt: s.last_at, auto: !!s.auto, turns: s.prompts, steps: s.steps, billed: s.billed,
      cost: costBy(`session_id = ? AND day >= ? AND ${F}`, [s.id, from]), models: modelsOf(s.id), where: whereOf(s.cwd, s.dir), subagents: s.subagents,
      ctx: last?.actual ?? 0, ctxPct: last ? last.actual / 1_000_000 : 0,
      cats: last && last.est > 0 ? Object.fromEntries(CATS.map(c => [c, Math.round(last[`e_${c}`] * last.actual / last.est)])) : null,
    };
  });
  return {
    range, from, fam, byModel: byModel(from),
    kpi: { sessions: k.sessions ?? 0, billed: k.billed ?? 0, cost: costBy(W, [from]), cacheHit: k.inp ? k.read / k.inp : 0, output: k.output ?? 0,
      calls: k.calls ?? 0, tools: k.tools ?? 0, toolMs: k.tool_ms ?? 0, modelMs: k.model_ms ?? 0, activeMs: (k.tool_ms ?? 0) + (k.model_ms ?? 0) },
    composition: { ...Object.fromEntries(CATS.map(c => [c, Math.round(comp?.[c] ?? 0)])), unsplit: comp?.unsplit ?? 0, output: k.output ?? 0 },
    timing: { modelMs: k.model_ms ?? 0, toolMs: k.tool_ms ?? 0, calls: k.calls ?? 0, tools: k.tools ?? 0, speed: k.model_ms ? (k.output ?? 0) / (k.model_ms / 1000) : 0 },
    week, heat, skills, cards,
    pinned: pinnedSessions().map(p => ({ id: p.id, title: p.name ?? p.title, lastAt: p.last_at, where: whereOf(p.cwd, p.dir) })),
  };
}

/** 会话用过的模型,用得多的在前 */
const modelsOf = (id: string) => (db.query(`SELECT model FROM cc_requests WHERE session_id = ? AND ${HAS} GROUP BY model ORDER BY count(*) DESC`).all(id) as any[]).map(r => r.model as string);

export function sessionSummary(id: string) {
  const s = db.query("SELECT * FROM cc_sessions WHERE id = ?").get(id) as any;
  if (!s) return null;
  const l = labelsOf([id]).get(id);
  return { ...s, where: whereOf(s.cwd, s.dir), resume: `claude --resume ${id}`, name: l?.name ?? null, pinned: !!l?.pinnedAt };
}

/**
 * 搜会话:不分时间范围,按空格拆词。每个词要出现在标题、最后一句、启动目录、会话 id,或者这个会话里你说过的任何一句话里。
 * 空查询给最近的几个。命中的是说过的话时,带上那一句(said)方便认出来。
 */
export function searchSessions(q: string, limit = 12) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const hay = "lower(coalesce(l.name, '') || ' ' || coalesce(s.title, '') || ' ' || coalesce(s.last_prompt, '') || ' ' || coalesce(s.cwd, '') || ' ' || s.id)";
  const one = `(instr(${hay}, ?) > 0 OR EXISTS (SELECT 1 FROM cc_prompts p WHERE p.session_id = s.id AND instr(lower(p.text), ?) > 0))`;
  // 固定的排前面
  const rows = db.query(`SELECT s.id, s.dir, s.cwd, s.title, s.last_prompt, s.last_at, s.auto, s.subagents, l.name, l.pinned_at FROM cc_sessions s
    LEFT JOIN cc_labels l ON l.session_id = s.id
    WHERE s.first_at IS NOT NULL ${words.map(() => "AND " + one).join(" ")} ORDER BY (l.pinned_at IS NOT NULL) DESC, s.last_at DESC LIMIT ?`).all(...words.flatMap(w => [w, w]), limit) as any[];
  const saidQ = db.query("SELECT text FROM cc_prompts WHERE session_id = ? AND instr(lower(text), ?) > 0 ORDER BY at DESC LIMIT 1");
  return rows.map(r => {
    const inHead = words.length && words.every(w => `${r.name ?? ""} ${r.title ?? ""} ${r.last_prompt ?? ""}`.toLowerCase().includes(w));
    const said = words.length && !inHead ? (saidQ.get(r.id, words[0]) as { text: string } | null)?.text ?? null : null;
    return { id: r.id, title: r.title, name: r.name ?? null, pinned: !!r.pinned_at, lastPrompt: r.last_prompt, said, lastAt: r.last_at, auto: !!r.auto, subagents: r.subagents, where: whereOf(r.cwd, r.dir) };
  });
}

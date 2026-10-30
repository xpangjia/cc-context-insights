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

ensureSchema(db);
export type Range = "today" | "7d" | "30d" | "all";
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

export function insights(range: Range, q = "") {
  const from = fromOf(range);
  const W = "day >= ?";
  const k = db.query(`SELECT count(DISTINCT session_id) sessions, sum(${ACT} + output) billed, sum(${ACT}) inp, sum(cache_read) read, sum(output) output,
    sum(answered) calls, sum(tool_calls) tools, sum(tool_ms) tool_ms, sum(model_ms) model_ms FROM cc_requests WHERE ${W}`).get(from) as any;
  const comp = db.query(`SELECT ${CATS.map(c => `sum(CASE WHEN (${EST}) > 0 THEN e_${c} * 1.0 * ${ACT} / (${EST}) ELSE 0 END) ${c}`).join(", ")},
    sum(CASE WHEN (${EST}) = 0 THEN ${ACT} ELSE 0 END) unsplit FROM cc_requests WHERE ${W}`).get(from) as any;
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = daysAgo(i);
    const t = db.query(`SELECT sum(${ACT} + output) billed FROM cc_requests WHERE day = ?`).get(day) as any;
    week.push({ day, billed: t?.billed ?? 0, cost: costBy("day = ?", [day]) });
  }
  const heat = db.query(`SELECT day, sum(${ACT} + output) billed, count(DISTINCT session_id) sessions FROM cc_requests WHERE day >= ? GROUP BY day`).all(daysAgo(55));
  const names = skillNames();
  const skills = (db.query(`SELECT skill, count(*) n, max(at) last FROM cc_skills WHERE at >= ? GROUP BY skill ORDER BY n DESC`).all(from) as any[]).filter(s => names.has(s.skill));
  const ss = db.query(`SELECT s.*, x.billed, x.steps FROM cc_sessions s JOIN (
      SELECT session_id, sum(${ACT} + output) billed, count(*) steps FROM cc_requests WHERE ${W} GROUP BY session_id
    ) x ON x.session_id = s.id ${q ? "WHERE s.title LIKE ? OR s.last_prompt LIKE ?" : ""} ORDER BY s.last_at DESC LIMIT 300`)
    .all(from, ...(q ? [`%${q}%`, `%${q}%`] : [])) as any[];
  const cards = ss.map(s => {
    const last = db.query(`SELECT *, ${ACT} actual, (${EST}) est FROM cc_requests WHERE session_id = ? AND agent IS NULL AND answered = 1 ORDER BY at DESC LIMIT 1`).get(s.id) as any;
    return {
      id: s.id, title: s.title, lastPrompt: s.last_prompt, lastAt: s.last_at, auto: !!s.auto, turns: s.prompts, steps: s.steps, billed: s.billed,
      cost: costBy("session_id = ? AND day >= ?", [s.id, from]), where: whereOf(s.cwd, s.dir), subagents: s.subagents,
      ctx: last?.actual ?? 0, ctxPct: last ? last.actual / 1_000_000 : 0,
      cats: last && last.est > 0 ? Object.fromEntries(CATS.map(c => [c, Math.round(last[`e_${c}`] * last.actual / last.est)])) : null,
    };
  });
  return {
    range, from,
    kpi: { sessions: k.sessions ?? 0, billed: k.billed ?? 0, cost: costBy(W, [from]), cacheHit: k.inp ? k.read / k.inp : 0, output: k.output ?? 0,
      calls: k.calls ?? 0, tools: k.tools ?? 0, toolMs: k.tool_ms ?? 0, modelMs: k.model_ms ?? 0, activeMs: (k.tool_ms ?? 0) + (k.model_ms ?? 0) },
    composition: { ...Object.fromEntries(CATS.map(c => [c, Math.round(comp?.[c] ?? 0)])), unsplit: comp?.unsplit ?? 0, output: k.output ?? 0 },
    timing: { modelMs: k.model_ms ?? 0, toolMs: k.tool_ms ?? 0, calls: k.calls ?? 0, tools: k.tools ?? 0, speed: k.model_ms ? (k.output ?? 0) / (k.model_ms / 1000) : 0 },
    week, heat, skills, cards,
  };
}

export function sessionSummary(id: string) {
  const s = db.query("SELECT * FROM cc_sessions WHERE id = ?").get(id) as any;
  if (!s) return null;
  return { ...s, where: whereOf(s.cwd, s.dir), resume: `claude --resume ${id}` };
}

/**
 * 搜会话:不分时间范围,按空格拆词。每个词要出现在标题、最后一句、启动目录、会话 id,或者这个会话里你说过的任何一句话里。
 * 空查询给最近的几个。命中的是说过的话时,带上那一句(said)方便认出来。
 */
export function searchSessions(q: string, limit = 12) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const hay = "lower(coalesce(s.title, '') || ' ' || coalesce(s.last_prompt, '') || ' ' || coalesce(s.cwd, '') || ' ' || s.id)";
  const one = `(instr(${hay}, ?) > 0 OR EXISTS (SELECT 1 FROM cc_prompts p WHERE p.session_id = s.id AND instr(lower(p.text), ?) > 0))`;
  const rows = db.query(`SELECT s.id, s.dir, s.cwd, s.title, s.last_prompt, s.last_at, s.auto, s.subagents FROM cc_sessions s
    WHERE s.first_at IS NOT NULL ${words.map(() => "AND " + one).join(" ")} ORDER BY s.last_at DESC LIMIT ?`).all(...words.flatMap(w => [w, w]), limit) as any[];
  const saidQ = db.query("SELECT text FROM cc_prompts WHERE session_id = ? AND instr(lower(text), ?) > 0 ORDER BY at DESC LIMIT 1");
  return rows.map(r => {
    const inHead = words.length && words.every(w => `${r.title ?? ""} ${r.last_prompt ?? ""}`.toLowerCase().includes(w));
    const said = words.length && !inHead ? (saidQ.get(r.id, words[0]) as { text: string } | null)?.text ?? null : null;
    return { id: r.id, title: r.title, lastPrompt: r.last_prompt, said, lastAt: r.last_at, auto: !!r.auto, subagents: r.subagents, where: whereOf(r.cwd, r.dir) };
  });
}

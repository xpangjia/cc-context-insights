/**
 * DeepSeek Harness(dsh)会话 → Claude Code 日志格式
 *
 * dsh 把每个会话记在 <sessions>/<按目录编码>/<会话号>/session.v4.jsonl.zstd(zstd 压缩的事件流)。
 * 这里把它翻译成 Claude Code 的 jsonl(user / assistant / attachment 行),写进本工具自己的数据目录,
 * 索引和会话页原样复用,不为 dsh 另写一套统计。
 *
 * 对应关系:
 *   system/message + request/header 的工具定义 → prompt_snapshot 附件(系统提示词、工具定义)
 *   user/message:人发的(没有来源、来源是 user 或桥接插件)→ 用户消息;dsh 自己注入的(运行环境、技能目录、时间……)→ 附件
 *   assistant/message → 助手回复(思考、文字、工具调用),用量换成 Claude 的字段
 *   tool/result → 工具返回
 *   子 Agent 会话(session.parentSession)→ 父会话的 subagents/agent-<编号>.jsonl;派它的那次调用按时间对上,记在 meta.json 的 toolUseId
 * 翻译是确定的:日志只追加时,新译文的前缀和旧译文一样,索引照样只读新增的部分。
 */
import { readdirSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

type Ev = { type: string; time?: number; data?: any; [k: string]: any };
export type Head = { id: string; cwd: string; createdAt: number; parent: string | null; label: string | null; model: string | null };

/** dsh 工具名 → Claude Code 工具名(会话页的文件活动、命令执行、技能、子 Agent 都按 Claude 的名字认) */
const TOOL: Record<string, string> = {
  bash: "Bash", read: "Read", read_image: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob",
  web_fetch: "WebFetch", web_search: "WebSearch", skill: "Skill", todo_write: "TodoWrite", send_message: "SendMessage",
  subagent: "Agent", subagent_fork: "Agent", spawn_teammate: "Agent",
};
const SPAWN = new Set(["subagent", "subagent_fork", "spawn_teammate"]);

function toolInput(name: string, raw: unknown): any {
  let a: any = raw;
  if (typeof raw === "string") { try { a = JSON.parse(raw || "{}"); } catch { a = { arguments: raw }; } }
  a = a && typeof a === "object" ? a : {};
  if (name === "skill") return { skill: a.name ?? a.skill ?? "", args: a.args ?? "" };
  if (name === "web_search") return { query: Array.isArray(a.queries) ? a.queries.join(" | ") : a.query ?? "" };
  if (name === "send_message") return { to: a.target ?? a.agent_id ?? "", message: a.message ?? "" };
  if (SPAWN.has(name)) return { description: a.description ?? a.name ?? "", prompt: a.prompt ?? "", subagent_type: name };
  return a;
}

const textOf = (content: any): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text ?? "" : "")).join("\n") : "";

/** 人发的消息:没有来源,或来源是人 / 工作台桥接 / 编排器转来的活 */
const HUMAN = new Set(["user", "wb-bridge", "dsh-superagent", "schedule"]);
/** dsh 注入内容的来源 → 附件类型(中文名在 classify 的 ATT_KIND 里,认不得的显示「附件 xxx」) */
const INJECT: Record<string, string> = {
  "runtime-context": "environment", "time-context": "date", "skill-catalog": "skill_listing", "agent-instructions": "nested_memory",
  "tool-jobs": "dsh_后台任务", "agent-message": "dsh_同伴消息", "subagent-settled": "dsh_子Agent完成", "user-approval": "dsh_批准",
};

export function decode(file: string): Ev[] {
  const raw = Bun.zstdDecompressSync(readFileSync(file));
  const out: Ev[] = [];
  for (const line of Buffer.from(raw).toString("utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function headOf(evs: Ev[]): Head | null {
  const s = evs.find(e => e.type === "session");
  if (!s?.id) return null;
  const d = evs.find(e => e.type === "subagent/descriptor")?.data;
  const m = evs.find(e => e.type === "model/selection")?.data?.model ?? d?.agentModel ?? null;
  return { id: s.id, cwd: s.cwd ?? "", createdAt: s.createdAt ?? 0, parent: s.parentSession ?? null, label: d?.label ?? null, model: m };
}

/**
 * 翻译一个会话,返回 jsonl 文本。只按事件顺序往下写,不回头改前面的行(索引按「只追加」增量读)。
 */
export function convert(evs: Ev[]): string {
  const h = headOf(evs);
  if (!h) return "";
  const lines: string[] = [];
  const iso = (t?: number) => new Date(t ?? h.createdAt).toISOString();
  // 工作台派的活和编排器派的活算「脚本自动」,自己在 dsh 里开的算手动
  const entry = /^session-wb-/.test(h.id) || evs.some(e => e.type === "user/message" && e.data?.source?.kind === "dsh-superagent") ? "dsh-auto" : "dsh";
  const base = (t?: number) => ({ sessionId: h.id, cwd: h.cwd, timestamp: iso(t), entrypoint: entry, isSidechain: !!h.parent });
  let sys = "", tools: any[] | null = null, snapSig = "";
  const snap = (t?: number) => {
    if (!sys && !tools) return;
    const sig = `${sys.length}:${tools?.length ?? -1}`;
    if (sig === snapSig) return;
    snapSig = sig;
    lines.push(JSON.stringify({ type: "attachment", ...base(t), attachment: { type: "prompt_snapshot", systemPrompt: sys ? [sys] : [], ...(tools ? { tools } : {}) } }));
  };
  let model = h.model;
  let n = 0;
  for (const e of evs) {
    const d = e.data ?? {};
    switch (e.type) {
      case "model/selection": model = d.model ?? model; break;
      // dsh 自己起的标题(后起的覆盖前面的);Claude Code 改名也是记一行 custom-title
      case "session/title": if (d.title) lines.push(JSON.stringify({ type: "custom-title", sessionId: h.id, customTitle: String(d.title) })); break;
      case "system/message": sys = textOf(d.message?.content); snap(e.time); break;
      case "request/header":
        tools = (d.header?.tools ?? []).map((t: any) => ({ name: TOOL[t.name] ?? t.name, description: t.description ?? "", schema: t.parameters ?? {} }));
        snap(e.time); break;
      case "user/message": {
        const kind = d.source?.kind ?? null;
        const text = textOf(d.content);
        if (!text.trim()) break;
        if (!kind || HUMAN.has(kind)) lines.push(JSON.stringify({ type: "user", ...base(e.time), uuid: `${h.id}:u${n++}`, message: { role: "user", content: text } }));
        else lines.push(JSON.stringify({ type: "attachment", ...base(e.time), attachment: { type: INJECT[kind] ?? `dsh_${kind}`, content: text } }));
        break;
      }
      case "assistant/message": {
        const m = d.message ?? {};
        const content: any[] = [];
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c.type === "reasoning") content.push({ type: "thinking", thinking: c.text ?? "", signature: "" });
          else if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
          else if (c.type === "tool-call") {
            content.push({ type: "tool_use", id: c.id, name: TOOL[c.name] ?? c.name, input: toolInput(c.name, c.arguments) });
          }
        }
        const u = d.usage ?? {};
        const mm = m.source?.model ?? model ?? "deepseek";
        lines.push(JSON.stringify({ type: "assistant", ...base(e.time), message: { id: m.id ?? `${h.id}:a${n++}`, role: "assistant", model: mm, content,
          usage: { input_tokens: u.inputTokens ?? 0, cache_read_input_tokens: u.cacheReadTokens ?? 0, cache_creation_input_tokens: u.cacheWriteTokens ?? 0, output_tokens: u.outputTokens ?? 0 } } }));
        break;
      }
      case "tool/result": {
        const m = d.message ?? {};
        const callId = m.toolCallId ?? m.source?.callId;
        lines.push(JSON.stringify({ type: "user", ...base(e.time), uuid: `${h.id}:u${n++}`,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: textOf(m.content), is_error: !!m.isError }] } }));
        break;
      }
      // 压缩:之前的对话换成一段摘要(只压了一段时是近似:当成全部压掉)
      case "compaction/summary": {
        const sum = typeof d.summary === "string" ? d.summary : textOf(d.summary?.content ?? d.summary);
        if (!sum) break;
        lines.push(JSON.stringify({ type: "system", subtype: "compact_boundary", ...base(e.time) }));
        lines.push(JSON.stringify({ type: "attachment", ...base(e.time), attachment: { type: "dsh_压缩摘要", content: sum } }));
        break;
      }
    }
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** 目录名按 Claude Code 的规则编码(非字母数字都换成 -),会话页按目录名显示在哪个项目 */
const encodeDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

type FileState = { size: number; mtime: number; head: Head | null };

/**
 * 把这些 dsh 会话目录里的会话翻译进 out。只翻有变化的(按大小和修改时间)。
 * 状态记在 out/.state.json。返回翻了几个,以及译文前缀变了、要整个重建索引的会话。
 */
export function mirrorAll(dirs: string[], out: string, log = (_: string) => {}) {
  mkdirSync(out, { recursive: true });
  const stateFile = join(out, ".state.json");
  let state: Record<string, FileState> = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
  const files: string[] = [];
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    for (const wd of readdirSync(root)) {
      const wp = join(root, wd);
      try { if (!statSync(wp).isDirectory()) continue; } catch { continue; }
      for (const sd of readdirSync(wp)) {
        const f = join(wp, sd, "session.v4.jsonl.zstd");
        if (existsSync(f)) files.push(f);
      }
    }
  }
  // 第一遍:找出有变化的,更新会话头(子 Agent 要靠它挂到父会话)
  const changed = new Map<string, Ev[]>();
  const next: Record<string, FileState> = {};
  for (const f of files) {
    const st = statSync(f);
    const prev = state[f];
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) { next[f] = prev; continue; }
    try { const evs = decode(f); changed.set(f, evs); next[f] = { size: st.size, mtime: st.mtimeMs, head: headOf(evs) }; }
    catch (e) { log(`dsh 会话读不了：${f}：${e}`); }
  }
  const heads = Object.entries(next).filter(([, s]) => s.head).map(([f, s]) => ({ f, h: s.head! }));
  const byId = new Map(heads.map(x => [x.h.id, x]));
  // 父会话里派子 Agent 的调用(调用号、时间),子 Agent 按创建时间依次认领在它之前、离它最近的那次
  const spawnsOf = (f: string) => (changed.get(f) ?? decode(f)).flatMap(e => e.type !== "assistant/message" ? [] :
    (e.data?.message?.content ?? []).filter((c: any) => c.type === "tool-call" && SPAWN.has(c.name)).map((c: any) => ({ id: c.id as string, at: e.time ?? 0 })));
  const linkOf = (parent: { f: string; h: Head }, child: Head) => {
    const calls = spawnsOf(parent.f);
    const kids = heads.filter(x => x.h.parent === parent.h.id).map(x => x.h).sort((a, b) => a.createdAt - b.createdAt);
    const used = new Set<string>();
    for (const k of kids) {
      const c = calls.filter(c => !used.has(c.id) && c.at <= k.createdAt + 2000).pop();
      if (c) used.add(c.id);
      if (k.id === child.id) return c?.id ?? null;
    }
    return null;
  };
  const rewritten = new Set<string>();
  // 写之前看旧译文是不是新译文的开头:不是(dsh 改写过日志)就记下来,让索引把这个会话整个重建
  const write = (path: string, text: string, sid: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path) && path.endsWith(".jsonl")) { const old = readFileSync(path, "utf8"); if (!text.startsWith(old)) rewritten.add(sid); }
    writeFileSync(path + ".tmp", text); renameSync(path + ".tmp", path);
  };
  let n = 0;
  for (const [f, evs] of changed) {
    const h = next[f]?.head;
    if (!h) continue;
    const text = convert(evs);
    if (!text) continue;
    if (h.parent) {
      const p = byId.get(h.parent);
      if (!p) continue; // 父会话不在(被删了):不单独列
      const dir = join(out, encodeDir(p.h.cwd), p.h.id, "subagents");
      write(join(dir, `agent-${h.id}.jsonl`), text, p.h.id);
      write(join(dir, `agent-${h.id}.meta.json`), JSON.stringify({ agentType: "dsh", description: h.label ?? "子 Agent", toolUseId: linkOf(p, h), finished: true }), p.h.id);
    } else write(join(out, encodeDir(h.cwd), `${h.id}.jsonl`), text, h.id);
    n++;
  }
  writeFileSync(stateFile, JSON.stringify(next));
  if (n) log(`dsh 会话：翻译 ${n} 个`);
  return { n, rewritten: [...rewritten] };
}

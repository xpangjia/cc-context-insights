/**
 * 上下文分类与 token 估算(纯函数)
 * 七类和参考插件 dsh-context 一致:系统提示词、工具定义、用户消息、注入内容、技能注入、助手消息、工具结果
 * token 先按字数估,用的时候再按这次请求的实际输入总量等比缩放
 */

export const CATS = ["system", "tools", "user", "inject", "skill", "assistant", "tool"] as const;
export type Cat = (typeof CATS)[number];
export const CAT_CN: Record<Cat, string> = {
  system: "系统提示词", tools: "工具定义", user: "用户消息", inject: "注入内容", skill: "技能注入", assistant: "助手消息", tool: "工具结果",
};
/** 消息里会出现的五类(系统提示词和工具定义来自请求外壳) */
export const MSG_CATS = ["user", "inject", "skill", "assistant", "tool"] as const;
export type Vec = [number, number, number, number, number]; // 顺序同 MSG_CATS
export const zero = (): Vec => [0, 0, 0, 0, 0];
export const addVec = (a: Vec, b: Vec): Vec => a.map((x, i) => x + b[i]) as Vec;
const IDX = { user: 0, inject: 1, skill: 2, assistant: 3, tool: 4 } as const;

/** 图片按固定量估(日志里看不到尺寸,取 1600 左右的常见值) */
export const IMAGE_TOKENS = 1600;

/** 字数估 token:中日韩字约 1 个/字,其他约 3.6 个字符 1 个 */
export function est(s: string | undefined | null): number {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++; }
  return Math.round(cjk + (s.length - cjk) / 3.6);
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SKILL_LIST = /skills are available for use with the Skill tool|The following skills are available/i;
/** 系统自动加进对话的文字:以标签开头(<total_tokens>、<local-command-…>、<task-notification> 等)、环境信息、中断提示 */
const WRAPPER = /^\s*<([a-z][a-z0-9_-]*)>/i;
const HARNESS_TEXT = /^\s*(# Environment\b|Caveat:|\[Request interrupted)/;
const WRAP_KIND: Record<string, string> = { total_tokens: "余量提示", "task-notification": "任务通知", "local-command-caveat": "命令外壳", "command-name": "命令外壳", "local-command-stdout": "命令外壳" };

export type Item = { cat: Cat; kind: string; tokens: number; text: string; name?: string };

/** 一段用户文字拆开:提醒(注入/技能目录) + 命令外壳(注入) + 剩下的才是你真正打的字 */
export function splitUserText(text: string): Item[] {
  const out: Item[] = [];
  for (const m of text.match(REMINDER) ?? []) {
    out.push({ cat: SKILL_LIST.test(m) ? "skill" : "inject", kind: SKILL_LIST.test(m) ? "技能目录" : "系统提醒", tokens: est(m), text: m });
  }
  const rest = text.replace(REMINDER, "").trim();
  if (rest) {
    const w = rest.match(WRAPPER);
    if (w) out.push({ cat: "inject", kind: WRAP_KIND[w[1]] ?? "系统包装", tokens: est(rest), text: rest });
    else if (HARNESS_TEXT.test(rest)) out.push({ cat: "inject", kind: /Environment/.test(rest.slice(0, 20)) ? "环境信息" : "系统包装", tokens: est(rest), text: rest });
    else out.push({ cat: "user", kind: "输入", tokens: est(rest), text: rest });
  }
  return out;
}

const resultText = (c: any): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.type === "text" ? x.text : "").join("\n") : "";

/**
 * 一条消息拆成若干条目。skillIds:本会话里 Skill 工具调用的 id(它的返回内容算技能注入)
 * toolNames:tool_use id → 工具名,给工具结果标名字
 */
export function messageItems(msg: any, skillIds: Set<string>, toolNames?: Map<string, string>): Item[] {
  const out: Item[] = [];
  const content = msg?.content;
  if (msg?.role === "assistant") {
    for (const c of Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }]) {
      if (c.type === "text" && c.text) out.push({ cat: "assistant", kind: "回答", tokens: est(c.text), text: c.text });
      else if (c.type === "thinking") out.push({ cat: "assistant", kind: "思考", tokens: est(c.thinking) + Math.round((c.signature?.length ?? 0) / 6), text: c.thinking || "（思考内容不返回，只留签名）" });
      else if (c.type === "redacted_thinking") out.push({ cat: "assistant", kind: "思考", tokens: Math.round((c.data?.length ?? 0) / 6), text: "（加密的思考）" });
      else if (c.type === "tool_use") {
        const input = JSON.stringify(c.input ?? {});
        if (c.name === "Skill" && c.id) skillIds.add(c.id);
        toolNames?.set(c.id, c.name);
        out.push({ cat: "assistant", kind: "工具调用", name: c.name, tokens: est(input) + 8, text: input });
      }
    }
    return out;
  }
  if (typeof content === "string") return splitUserText(content);
  for (const c of Array.isArray(content) ? content : []) {
    if (c.type === "text") out.push(...splitUserText(c.text ?? ""));
    else if (c.type === "image") out.push({ cat: "user", kind: "图片", tokens: IMAGE_TOKENS, text: "（图片）" });
    else if (c.type === "document") out.push({ cat: "user", kind: "文档", tokens: est(JSON.stringify(c.source ?? "")) / 2, text: "（文档）" });
    else if (c.type === "tool_result") {
      const isSkill = skillIds.has(c.tool_use_id);
      const text = resultText(c.content);
      const imgs = Array.isArray(c.content) ? c.content.filter((x: any) => x?.type === "image").length : 0;
      out.push({ cat: isSkill ? "skill" : "tool", kind: isSkill ? "技能加载" : c.is_error ? "工具报错" : "工具结果", name: toolNames?.get(c.tool_use_id),
        tokens: est(text) + imgs * IMAGE_TOKENS + 6, text: text + (imgs ? `\n（另有 ${imgs} 张图）` : "") });
    }
  }
  return out;
}

export function messageVec(msg: any, skillIds: Set<string>): Vec {
  const v = zero();
  for (const it of messageItems(msg, skillIds)) if (it.cat in IDX) v[IDX[it.cat as keyof typeof IDX]] += it.tokens;
  return v;
}

/** 请求外壳:系统提示词各块 + 每个工具定义 */
export function shapeItems(shape: any): Item[] {
  const out: Item[] = [];
  for (const b of shape?.system ?? []) out.push({ cat: "system", kind: "系统提示词", tokens: est(b.text), text: b.text ?? "" });
  for (const t of shape?.tools ?? []) {
    const s = JSON.stringify(t);
    out.push({ cat: "tools", kind: "工具定义", name: t.name, tokens: est(s), text: s });
  }
  return out;
}
export const shapeVec = (shape: any): [number, number] => {
  let s = 0, t = 0;
  for (const it of shapeItems(shape)) it.cat === "system" ? (s += it.tokens) : (t += it.tokens);
  return [s, t];
};

/** 估算值按实际输入总量等比缩放,让各类加起来等于官方计量 */
export function scaleTo(parts: number[], actual: number): number[] {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!sum || !actual) return parts.map(() => 0);
  const k = actual / sum;
  return parts.map(p => Math.round(p * k));
}

// ---------- 价格(官方价,每百万 token,美元) ----------

type Price = { in: number; out: number; read: number };
const PRICES: [RegExp, Price][] = [
  [/fable-5|mythos-5/, { in: 10, out: 50, read: 0.25 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-(5|4-[5-8])/, { in: 5, out: 25, read: 0.5 }],
  [/opus-4(-[01])?($|-|\[)/, { in: 15, out: 75, read: 1.5 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3 }],
  [/haiku-5/, { in: 0.1, out: 0.5, read: 0.01 }],
  [/haiku/, { in: 1, out: 5, read: 0.1 }],
];
export const priceOf = (model: string | null | undefined): Price | null => {
  if (!model) return null;
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null;
};
/** 缓存写入:5 分钟按输入价 1.25 倍,1 小时按 2 倍 */
export function costOf(model: string | null | undefined, u: { input: number; read: number; w5: number; w1h: number; output: number }) {
  const p = priceOf(model);
  if (!p) return null;
  return (u.input * p.in + u.read * p.read + u.w5 * p.in * 1.25 + u.w1h * p.in * 2 + u.output * p.out) / 1e6;
}

/** 上下文窗口:当前在用的模型都是 100 万,Haiku 4.5 及更早是 20 万 */
export const windowOf = (model: string | null | undefined) =>
  !model ? 1_000_000 : /haiku-4|claude-3|sonnet-4-5|opus-4-[015]($|-)/.test(model) ? 200_000 : 1_000_000;

/** 计时口径:单次工具/模型调用最多按 30 分钟计(更长多半是电脑休眠或在等确认);派子 Agent 的调用不计工具时长(子 Agent 自己的时间另算) */
export const MAX_CALL_MS = 30 * 60 * 1000;
export const NO_TIME_TOOLS = new Set(["Agent", "Task"]);
export const capMs = (ms: number) => Math.min(Math.max(0, ms), MAX_CALL_MS);

/** 上下文七类:名字、颜色、格式化 */
/** base = 系统与工具合计:日志里没有系统提示词和工具定义时才有,其他时候是 0,界面上不显示 */
export const CATS = ["system", "tools", "base", "user", "inject", "skill", "assistant", "tool"] as const;
/** 「系统与工具(合计)」只在有值时显示;只有合计、没有分开的系统提示词和工具定义时,那两项不显示 0 */
export const shown = (has: (c: string) => boolean) => {
  const onlyBase = has("base") && !has("system") && !has("tools");
  return CATS.filter(c => (c === "base" ? has(c) : c === "system" || c === "tools" ? !onlyBase : true));
};
export type Cat = (typeof CATS)[number];
export const CAT_CN: Record<string, string> = {
  system: "系统提示词", tools: "工具定义", base: "系统与工具（合计）", user: "用户消息", inject: "注入内容", skill: "技能注入", assistant: "助手消息", tool: "工具结果",
  output: "输出", unsplit: "未拆分（旧版记录）", free: "空闲窗口",
};
export const color = (c: string) => `var(--c-${c})`;

/** token 数:1.2 亿 / 14.2 万 / 860 */
export const tk = (n: number | null | undefined) => {
  const v = n ?? 0;
  return v >= 1e8 ? `${(v / 1e8).toFixed(1)} 亿` : v >= 1e4 ? `${(v / 1e4).toFixed(1)} 万` : `${Math.round(v)}`;
};
export const pct = (x: number, digits = 1) => (x < 0.001 && x > 0 ? "<0.1%" : `${(x * 100).toFixed(digits)}%`);
export const usd = (n: number | null | undefined) => (n == null ? "—" : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
/** 时长:2 小时 23 分 / 20 分 4 秒 / 33.6 秒 */
export function dms(ms: number | null | undefined) {
  const v = ms ?? 0;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} 秒`;
  const m = Math.floor(v / 60_000), h = Math.floor(m / 60);
  if (h >= 10) return `${h} 小时`;
  return h ? `${h} 小时 ${m % 60} 分` : `${m} 分 ${Math.round((v % 60_000) / 1000)} 秒`;
}
export const ago = (ts: string | null | undefined) => {
  if (!ts) return "—";
  const d = (Date.now() - new Date(ts.replace(" ", "T")).getTime()) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))} 分钟前` : d < 86400 ? `${Math.round(d / 3600)} 小时前` : `${Math.round(d / 86400)} 天前`;
};

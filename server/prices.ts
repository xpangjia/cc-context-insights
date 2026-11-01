/**
 * 公开价目表:models.dev(社区维护,各家模型的输入、输出、缓存单价,美元 / 百万 token)。
 * 启动时先读本机存的那份,再在后台拉新的;之后每天刷新一次。拉不到就一直用存的那份,一份都没有就只认 Claude 的内置价。
 * 同一个模型多家都卖时:优先原厂(价目表里的厂商 id 是模型名的开头,比如 deepseek / zhipuai 的 glm),标 0 元的包月套餐排最后。
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./paths";
import { setOpenPrices, type Price } from "./classify";

const FILE = join(DATA_DIR, "models-dev.json");
const URL_ = process.env.CC_INSIGHTS_PRICES_URL ?? "https://models.dev/api.json";
const MAKERS: Record<string, string[]> = { deepseek: ["deepseek"], glm: ["zhipuai", "zai"], kimi: ["moonshotai", "moonshotai-cn"], qwen: ["alibaba", "alibaba-cn"], minimax: ["minimax"] };

/** 各家的旧名 / 别名:接口返回的还是旧名,价目表里只有新名 */
const ALIASES: Record<string, string> = { "deepseek-chat": "deepseek-flash", "deepseek-reasoner": "deepseek-flash" };

export function buildTable(t: any): Map<string, Price> {
  const best = new Map<string, { p: Price; score: number }>();
  for (const [pid, prov] of Object.entries<any>(t ?? {})) {
    for (const [mid, m] of Object.entries<any>(prov?.models ?? {})) {
      const c = m?.cost;
      if (!c || typeof c.input !== "number") continue;
      const id = mid.toLowerCase();
      const fam = Object.keys(MAKERS).find(k => id.startsWith(k));
      const score = (fam && MAKERS[fam].includes(pid) ? 4 : 0) + (id.startsWith(pid) ? 2 : 0) - (c.input === 0 ? 10 : 0);
      const p: Price = { in: c.input, out: c.output ?? c.input, read: c.cache_read ?? c.input };
      const cur = best.get(id);
      if (!cur || score > cur.score) best.set(id, { p, score });
    }
  }
  const out = new Map([...best].map(([k, v]) => [k, v.p]));
  for (const [old, now] of Object.entries(ALIASES)) if (out.has(now)) out.set(old, out.get(now)!);  // 旧名跟着新名的原厂价走
  return out;
}

function loadSaved() {
  try { if (existsSync(FILE)) setOpenPrices(buildTable(JSON.parse(readFileSync(FILE, "utf8")))); } catch {}
}
export async function refresh(force = false) {
  try { if (!force && existsSync(FILE) && Date.now() - statSync(FILE).mtimeMs < 86400_000) return; } catch {}
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return;
    const text = await r.text();
    const table = buildTable(JSON.parse(text));
    if (!table.size) return;
    writeFileSync(FILE, text);
    setOpenPrices(table);
  } catch {}
}
export function startPrices() {
  loadSaved();
  refresh();
  setInterval(() => refresh(), 6 * 3600_000).unref?.();
}

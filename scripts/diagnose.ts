/**
 * 排查用:统计本机会话日志的格式,只输出数量,不含任何对话内容,可以直接发给别人看。
 * 用法:bun run diagnose
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { CC_ROOT, DATA_DIR } from "../server/paths";

if (!existsSync(CC_ROOT)) { console.log(`没找到会话日志目录:${CC_ROOT}`); process.exit(1); }
type Row = { files: number; mb: number; apiReq: number; snapshot: number; attachment: number; replies: number };
const byVer = new Map<string, Row>();
const MARK = { apiReq: '"type":"api-request"', snapshot: '"prompt_snapshot"', attachment: '"type":"attachment"' };
let n = 0;
for (const dir of readdirSync(CC_ROOT)) {
  const d = join(CC_ROOT, dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(d, f), size = statSync(p).size;
    const fd = openSync(p, "r"), buf = Buffer.alloc(Math.min(size, 64 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
    const s = buf.toString("utf8");
    const ver = s.match(/"version":"([^"]+)"/)?.[1] ?? "未知";
    const r = byVer.get(ver) ?? { files: 0, mb: 0, apiReq: 0, snapshot: 0, attachment: 0, replies: 0 };
    r.files++; r.mb += size / 1048576;
    if (s.includes(MARK.apiReq)) r.apiReq++;
    if (s.includes(MARK.snapshot)) r.snapshot++;
    if (s.includes(MARK.attachment)) r.attachment++;
    r.replies += (s.match(/"usage":\{/g) ?? []).length;
    byVer.set(ver, r);
    if (++n % 200 === 0) process.stderr.write(`已看 ${n} 个文件…\n`);
  }
}
console.log(`会话日志目录:${CC_ROOT.replace(/^\/(Users|home)\/[^/]+/, "~")}\n`);
console.log("Claude Code 版本 | 会话文件 | 大小 MB | 有请求记录 | 有提示词快照 | 有附件 | 带用量的回复行");
for (const [v, r] of [...byVer].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })))
  console.log(`${v} | ${r.files} | ${r.mb.toFixed(1)} | ${r.apiReq} | ${r.snapshot} | ${r.attachment} | ${r.replies}`);
const dbf = join(DATA_DIR, "index.db");
if (existsSync(dbf)) {
  const db = new Database(dbf, { readonly: true });
  try {
    const ver = (db.query("SELECT value FROM cc_meta WHERE key = 'version'").get() as any)?.value;
    console.log(`\n索引格式版本 ${ver}`);
    const cols = new Set((db.query("PRAGMA table_info(cc_requests)").all() as any[]).map(c => c.name));
    const est = ["e_system", "e_tools", "e_base", "e_user", "e_inject", "e_skill", "e_assistant", "e_tool"].filter(c => cols.has(c)).join(" + ");
    console.log("请求来源 | 条数 | 能拆分的 | 输入 token");
    for (const r of db.query(`SELECT CASE source WHEN 'transcript' THEN '从对话还原' WHEN 'legacy' THEN '拆不开' ELSE '有请求记录' END kind,
      count(*) n, sum(CASE WHEN ${est} > 0 THEN 1 ELSE 0 END) split, sum(input + cache_read + w5 + w1h) inp FROM cc_requests GROUP BY kind ORDER BY n DESC`).all() as any[])
      console.log(`${r.kind} | ${r.n} | ${r.split} | ${r.inp}`);
  } catch (e) { console.log(`\n读索引出错:${e}`); }
} else console.log("\n还没有索引(先运行一次 ./start.sh)");
console.log("\n有请求记录 = 日志里存了每次请求的完整内容,最准;从对话还原 = 没有请求记录,按对话、附件和提示词快照推算;拆不开 = 连对话内容都找不到。");

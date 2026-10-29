/**
 * Claude Code 上下文洞察:本地网页,读 ~/.claude/projects 下的会话日志(只读),只听 127.0.0.1
 */
import { existsSync } from "fs";
import { join, normalize } from "path";
import { ROOT, PORT, CC_ROOT } from "./paths";
import { cached, invalidate } from "./cache";
import { insights, sessionSummary, type Range, searchSessions } from "./insights";
import { contextView, traceView, fleetView, requestBrowser, agentModelOf, titleOf } from "./context";

const DIST = join(ROOT, "web/dist");
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// 后台线程增量建索引:启动时一次,之后每 2 分钟
let status: any = { ok: null, at: null };
const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
worker.onmessage = e => { status = e.data; invalidate("ins:"); };
worker.onerror = e => { status = { ok: false, at: new Date().toISOString(), error: String(e.message) }; };

const routes: Record<string, (url: URL) => Response | Promise<Response>> = {
  "/api/status": () => json({ index: status, logs: CC_ROOT, logsFound: existsSync(CC_ROOT) }),
  "/api/insights": async url => {
    const r = url.searchParams.get("range") ?? "30d";
    const range = (["today", "7d", "30d", "all"].includes(r) ? r : "30d") as Range;
    const q = url.searchParams.get("q") ?? "";
    return json({ ...(await cached(`ins:${range}:${q}`, 15000, async () => insights(range, q))), index: status });
  },
  "/api/search": url => json(searchSessions(url.searchParams.get("q") ?? "")),
  "/api/session": url => {
    const id = url.searchParams.get("id") ?? "";
    const s = sessionSummary(id);
    const m = agentModelOf(id, "main");
    return s ? json({ ...s, title: (m && titleOf(m)) ?? s.title }) : json({ error: "找不到这个会话（可能还在建索引）" }, 404);
  },
  "/api/session/context": url => { const d = contextView(url.searchParams.get("id") ?? "", url.searchParams.get("agent") ?? "main"); return d ? json(d) : json({ error: "找不到这个会话" }, 404); },
  "/api/session/request": url => {
    const m = agentModelOf(url.searchParams.get("id") ?? "", url.searchParams.get("agent") ?? "main");
    const d = m ? requestBrowser(m, Number(url.searchParams.get("idx") ?? -1)) : null;
    return d ? json(d) : json({ error: "找不到这次请求" }, 404);
  },
  "/api/session/trace": url => { const d = traceView(url.searchParams.get("id") ?? "", url.searchParams.get("agent") ?? "main"); return d ? json(d) : json({ error: "找不到这个会话" }, 404); },
  "/api/session/fleet": url => { const d = fleetView(url.searchParams.get("id") ?? ""); return d ? json(d) : json({ error: "找不到这个会话" }, 404); },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const h = routes[url.pathname];
    if (h) { try { return await h(url); } catch (e) { console.error(url.pathname, e); return json({ error: String(e) }, 500); } }
    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    const p = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (p.startsWith(DIST) && url.pathname !== "/" && existsSync(p) && !p.endsWith("/")) return new Response(Bun.file(p));
    const index = join(DIST, "index.html");
    return existsSync(index) ? new Response(Bun.file(index), { headers: { "cache-control": "no-cache" } }) : new Response("前端还没构建：先运行 bun run build", { status: 503 });
  },
});

const addr = `http://127.0.0.1:${server.port}`;
console.log(`\n  Claude Code 上下文洞察  ${addr}\n  读取会话日志：${CC_ROOT}${existsSync(CC_ROOT) ? "" : "（没找到这个目录，确认装过并用过 Claude Code）"}\n  第一次打开要建索引，几秒到一两分钟，看日志多少\n`);
if (!process.env.NO_OPEN) {
  const cmd = process.platform === "darwin" ? ["open", addr] : process.platform === "win32" ? ["cmd", "/c", "start", addr] : ["xdg-open", addr];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

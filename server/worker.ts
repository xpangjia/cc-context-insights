/** 后台线程:定时增量建会话索引,不阻塞接口 */
import { indexAll, purgeSession } from "./indexer";
import { db } from "./db";
import { LOG_ROOTS, DSH_DIRS, DSH_MIRROR } from "./paths";
import { mirrorAll } from "./dsh";

declare const self: Worker;

function run() {
  const t = Date.now();
  try {
    // 先把 dsh 的会话翻译过来,再一起建索引;dsh 这步出错不影响 Claude Code 的会话
    try { for (const sid of mirrorAll(DSH_DIRS, DSH_MIRROR, s => console.log(s)).rewritten) purgeSession(db, sid); }
    catch (e) { console.log(`dsh 会话翻译失败：${e}`); }
    const r = indexAll(db, LOG_ROOTS);
    postMessage({ ok: true, at: new Date().toISOString(), ms: Date.now() - t, ...r });
  } catch (e) {
    postMessage({ ok: false, at: new Date().toISOString(), error: String(e) });
  }
}
self.onmessage = () => run();
run();
setInterval(run, 120_000);

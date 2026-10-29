/** 后台线程:定时增量建会话索引,不阻塞接口 */
import { indexAll } from "./indexer";
import { db } from "./db";
import { CC_ROOT } from "./paths";

declare const self: Worker;
const ROOT = CC_ROOT;

function run() {
  const t = Date.now();
  try {
    const r = indexAll(db, ROOT);
    postMessage({ ok: true, at: new Date().toISOString(), ms: Date.now() - t, ...r });
  } catch (e) {
    postMessage({ ok: false, at: new Date().toISOString(), error: String(e) });
  }
}
self.onmessage = () => run();
run();
setInterval(run, 120_000);

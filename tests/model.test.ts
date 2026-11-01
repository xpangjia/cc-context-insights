/** 经网关换成别家模型:请求里写的是 Claude 的名字,回复里是真实模型,统计和会话页都按回复算 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { indexAll } from "../server/indexer";

test("模型名以回复里的为准", () => {
  const ROOT = `/tmp/cc-model-${process.pid}`, DIR = join(ROOT, "-Users-demo-proj");
  rmSync(ROOT, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  const L = (o: any) => JSON.stringify({ sessionId: "ds1", cwd: "/Users/demo/proj", ...o });
  const t = (s: number) => new Date(Date.UTC(2026, 9, 29, 1, 0, s)).toISOString();
  writeFileSync(join(DIR, "ds1.jsonl"), [
    L({ type: "user", timestamp: t(1), message: { role: "user", content: "你好" } }),
    L({ type: "api-request", id: "R1", timestamp: t(1), querySource: "main", keep: 0, tail: [], params: { model: "claude-opus-5-5" } }),
    L({ type: "assistant", requestRef: "R1", timestamp: t(3), message: { id: "m1", role: "assistant", model: "deepseek-flash", content: [{ type: "text", text: "好" }], usage: { input_tokens: 100, output_tokens: 20 } } }),
    "",
  ].join("\n"));
  const db = new Database(":memory:");
  indexAll(db, ROOT);
  const r = db.query("SELECT model, input, output FROM cc_requests WHERE session_id = 'ds1'").all() as any[];
  expect(r).toEqual([{ model: "deepseek-flash", input: 100, output: 20 }]);
  rmSync(ROOT, { recursive: true, force: true });
});

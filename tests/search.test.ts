import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { db } from "../server/db";
import { indexAll } from "../server/indexer";
import { searchSessions } from "../server/insights";

const ROOT = `/tmp/cc-search-fixture-${process.pid}`;
const DIR = join(ROOT, "-Users-demo-Documents-my-project");
const user = (sid: string, ts: string, text: string) => JSON.stringify({ type: "user", sessionId: sid, timestamp: ts, cwd: "/Users/demo/Documents/my-project", entrypoint: "cli", message: { role: "user", content: text } });

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "s1.jsonl"), [user("s1", "2026-10-28T01:00:00Z", "做一个工作台"), user("s1", "2026-10-28T02:00:00Z", "图表配色再调一下"), user("s1", "2026-10-28T03:00:00Z", "好了，提交"), user("s1", "2026-10-28T03:10:00Z", "Another Claude session sent a message:\n<msg>hi</msg>")].join("\n") + "\n");
  writeFileSync(join(DIR, "s2.jsonl"), [user("s2", "2026-10-29T01:00:00Z", "桃源游戏的菌房怎么用")].join("\n") + "\n");
  indexAll(db, ROOT);
});

test("空查询给最近的会话,新的在前", () => expect(searchSessions("").map(h => h.id)).toEqual(["s2", "s1"]));
test("能搜到中间说过的话,并带上那一句", () => {
  const r = searchSessions("配色");
  expect(r.map(h => h.id)).toEqual(["s1"]);
  expect(r[0].said).toBe("图表配色再调一下");
});
test("多个词都要命中(可以分散在标题和说过的话里)", () => {
  expect(searchSessions("工作台 配色").map(h => h.id)).toEqual(["s1"]);
  expect(searchSessions("工作台 菌房")).toEqual([]);
});
test("按启动目录和会话 id 也能搜", () => {
  expect(searchSessions("my-project").length).toBe(2);
  expect(searchSessions("s2").map(h => h.id)).toEqual(["s2"]);
});
test("标题里就有的词不重复给「说过」", () => expect(searchSessions("菌房")[0].said).toBeNull());
test("别的会话发进来的消息不算你说过的话", () => expect(searchSessions("another claude")).toEqual([]));

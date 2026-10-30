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

import { setLabel, labelsOf } from "../server/labels";
test("改名后能按新名字搜到,结果带名字;清空名字恢复原标题", () => {
  setLabel("s1", { name: "工作台配色定稿" });
  const r = searchSessions("定稿");
  expect(r.map(h => h.id)).toEqual(["s1"]);
  expect(r[0].name).toBe("工作台配色定稿");
  setLabel("s1", { name: "" });
  expect(labelsOf(["s1"]).get("s1")).toBeUndefined();
});
test("固定的会话在搜索里排最前,取消后回到按时间", () => {
  setLabel("s1", { pinned: true });
  expect(searchSessions("").map(h => h.id)).toEqual(["s1", "s2"]);
  expect(searchSessions("")[0].pinned).toBe(true);
  setLabel("s1", { pinned: false });
  expect(searchSessions("").map(h => h.id)).toEqual(["s2", "s1"]);
});
test("只改名不动固定,只固定不动名字", () => {
  setLabel("s2", { name: "菌房" }); setLabel("s2", { pinned: true });
  expect(labelsOf(["s2"]).get("s2")!.name).toBe("菌房");
  setLabel("s2", { name: "菌房调查" });
  expect(labelsOf(["s2"]).get("s2")!.pinnedAt).not.toBeNull();
});
test("索引格式升级、全部重建后,名字和固定还在", () => {
  db.query("UPDATE cc_meta SET value = 'old' WHERE key = 'version'").run();
  indexAll(db, ROOT);
  expect(labelsOf(["s2"]).get("s2")).toMatchObject({ name: "菌房调查" });
  expect(searchSessions("")[0].id).toBe("s2");
});

/** 没有 api-request 的日志从对话还原;新格式 tail 的补缺规则 */
import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { indexAll } from "../server/indexer";
import { parseAgentFile, reqCats, requestBrowser } from "../server/context";
import { messageItems, est } from "../server/classify";

const ROOT = `/tmp/cc-fallback-${process.pid}`;
const DIR = join(ROOT, "-Users-demo-proj");
const J = (sid: string) => (o: any) => JSON.stringify({ sessionId: sid, cwd: "/Users/demo/proj", ...o });
const usage = (input: number, out = 10) => ({ input_tokens: 5, cache_read_input_tokens: input - 5, cache_creation_input_tokens: 0, output_tokens: out });
const ts = (s: number) => new Date(Date.UTC(2026, 9, 29, 1, 0, s)).toISOString();
const SNAP = { type: "prompt_snapshot", systemPrompt: ["你是一个编程助手。".repeat(50)],
  tools: [{ name: "Bash", description: "跑命令", schema: { name: "Bash", description: "跑一条命令。".repeat(30), input_schema: { type: "object" } } }] };

function transcript(sid: string, withSnap: boolean) {
  const L = J(sid);
  return [
    ...(withSnap ? [L({ type: "attachment", timestamp: ts(0), attachment: SNAP })] : []),
    L({ type: "attachment", timestamp: ts(0), attachment: { type: "skill_listing", content: "- docx: 写 Word 文档\n- pdf: 处理 PDF".repeat(20) } }),
    L({ type: "attachment", timestamp: ts(0), attachment: { type: "credential_org", organizationUuid: "x" } }),
    L({ type: "user", timestamp: ts(1), message: { role: "user", content: "帮我看看这个目录" } }),
    L({ type: "assistant", requestRef: `${sid}-Q1`, timestamp: ts(4), message: { id: `${sid}-m1`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: usage(3000) } }),
    L({ type: "user", timestamp: ts(6), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt\nb.txt\n".repeat(200) }] } }),
    L({ type: "user", isSidechain: true, timestamp: ts(6), message: { role: "user", content: "老版本内联子任务,不在主对话里".repeat(100) } }),
    L({ type: "assistant", requestRef: `${sid}-Q2`, timestamp: ts(9), message: { id: `${sid}-m2`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "有两个文件" }], usage: usage(4000) } }),
    "",
  ].join("\n");
}

let db: Database;
beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "snap.jsonl"), transcript("snap", true));
  writeFileSync(join(DIR, "nosnap.jsonl"), transcript("nosnap", false));
  db = new Database(":memory:");
  indexAll(db, ROOT);
});
const rows = (sid: string) => db.query("SELECT * FROM cc_requests WHERE session_id = ? ORDER BY at").all(sid) as any[];

describe("没有请求记录、有提示词快照", () => {
  test("每条回复一条请求,来源标为对话还原;系统提示词和工具定义来自快照", () => {
    const r = rows("snap");
    expect(r.map(x => x.source)).toEqual(["transcript", "transcript"]);
    expect(r[0].e_system).toBeGreaterThan(0);
    expect(r[0].e_tools).toBeGreaterThan(0);
    expect(r[0].e_base).toBe(0);
    expect(r[0].e_skill).toBeGreaterThan(0);   // 技能目录附件
    expect(r[0].e_tool).toBe(0);
    expect(r[1].e_tool).toBeGreaterThan(0);    // 第二次请求带上了工具返回
    expect(r[1].e_assistant).toBeGreaterThan(0);
  });
  test("快照里 schema 本身就是完整工具定义时,说明不算两遍", () => {
    const one = est(JSON.stringify(SNAP.tools[0].schema));
    expect(rows("snap")[0].e_tools).toBe(one);
  });
  test("请求开始时间取前一条用户行,模型耗时有值", () => expect(rows("snap")[0].model_ms).toBe(3000));
  test("主文件里的 sidechain 行不进上下文", () => {
    const m = parseAgentFile(join(DIR, "snap.jsonl"), "main");
    const r2 = m.reqs[1];
    const texts = r2.keys.flatMap(k => messageItems(m.msgs.get(k), m.skillIds, m.toolNames).map(i => i.text)).join("");
    expect(texts.includes("老版本内联子任务")).toBe(false);
  });
  test("会话页还原:各类缩放后合计等于实际输入,不发给模型的附件不算", () => {
    const m = parseAgentFile(join(DIR, "snap.jsonl"), "main");
    const c = reqCats(m, m.reqs[1]);
    expect(Object.values(c.cats).reduce((a, b) => a + b, 0)).toBeCloseTo(4000, -1);
    expect(c.cats.tool).toBeGreaterThan(0);
    const br = requestBrowser(m, 0)!;
    expect(br.groups.flatMap(g => g.items).some(i => i.kind.includes("credential"))).toBe(false);
  });
});

describe("连快照也没有", () => {
  test("系统与工具记成合计:取第一次请求的「实际 − 对话部分」,第二次沿用同一个值", () => {
    const r = rows("nosnap");
    expect(r[0].e_system + r[0].e_tools).toBe(0);
    const msgs0 = r[0].e_user + r[0].e_inject + r[0].e_skill + r[0].e_assistant + r[0].e_tool;
    expect(r[0].e_base).toBe(3000 - msgs0);
    expect(r[1].e_base).toBe(r[0].e_base);
  });
  test("会话页浏览器里有一条「推算」的合计项", () => {
    const m = parseAgentFile(join(DIR, "nosnap.jsonl"), "main");
    const g = requestBrowser(m, 1)!.groups.find(g => g.cat === "base")!;
    expect(g.count).toBe(1);
    expect(g.items[0].kind).toBe("推算");
  });
});

describe("新格式 tail:回复存了档,只有工具返回没存", () => {
  test("补缺补的是工具返回,回复不重复算", () => {
    const L = J("newfmt");
    const reply = { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] };
    writeFileSync(join(ROOT, "newfmt.jsonl"), [
      L({ type: "api-request-shape", shapeHash: "S", shape: { system: [{ text: "你是助手" }], tools: [] } }),
      L({ type: "api-request-blob", hash: "U", message: { role: "user", content: "看看目录" } }),
      L({ type: "api-request", id: "R1", timestamp: ts(1), shapeHash: "S", keep: 0, tail: ["U"] }),
      L({ type: "assistant", requestRef: "R1", timestamp: ts(3), message: { ...reply, usage: usage(1000) } }),
      L({ type: "user", timestamp: ts(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "很多文件".repeat(100) }] } }),
      L({ type: "api-request-blob", hash: "A1", message: { role: "assistant", content: reply.content } }),
      L({ type: "api-request-blob", hash: "X", message: { role: "system", content: [{ type: "text", text: "# Environment\n平台 darwin\nThe following skills are available for use with the Skill tool:\n- docx: 写文档\n- pdf: 处理 PDF\n# MCP Server Instructions\n说明" }] } }),
      L({ type: "api-request", id: "R2", timestamp: ts(6), shapeHash: "S", keep: 1, tail: ["A1", "缺", "X"] }),
      L({ type: "assistant", requestRef: "R2", timestamp: ts(8), message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "好" }], usage: usage(1500) } }),
      "",
    ].join("\n"));
    const m = parseAgentFile(join(ROOT, "newfmt.jsonl"), "main");
    const kinds = m.reqs[1].keys.map(k => m.msgs.get(k)?.role);
    expect(kinds).toEqual(["user", "assistant", "user", "system"]);   // 用户、回复(只一次)、工具返回、系统消息
    const br = requestBrowser(m, 1)!;
    expect(br.groups.find(g => g.cat === "tool")!.count).toBe(1);
    expect(br.groups.find(g => g.cat === "skill")!.items[0].kind).toBe("技能目录");   // 系统消息里的技能目录切出来
    expect(br.groups.find(g => g.cat === "user")!.count).toBe(1);                      // 系统消息不算用户消息
  });
});

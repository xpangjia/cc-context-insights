import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { convert, mirrorAll } from "../server/dsh";
import { indexAll } from "../server/indexer";
import { parseAgentFile } from "../server/context";

/** 造一个 dsh 会话目录:<sessions>/<目录编码>/<会话号>/session.v4.jsonl.zstd */
const ROOT = `/tmp/dsh-fixture-${process.pid}`;
const SESS = join(ROOT, "sessions");
const OUT = join(ROOT, "mirror");
const T0 = Date.parse("2026-11-03T03:00:00Z");
const ev = (type: string, time: number, data: any) => ({ type, seq: 0, time: T0 + time, data });
const main = [
  { type: "session", version: 4, id: "session-demo", createdAt: T0, cwd: "/w/demo", isSeeded: false, delegationDepth: 0 },
  ev("model/selection", 1, { provider: "deepseek-official", model: "deepseek-flash" }),
  ev("user/message", 2, { id: "m1", role: "user", content: [{ type: "text", text: "帮我看看目录" }] }),
  ev("user/message", 3, { content: [{ type: "text", text: "Current runtime context. cwd=/w/demo" }], source: { kind: "runtime-context" } }),
  ev("user/message", 4, { content: [{ type: "text", text: "The following skills are available in this session: a, b" }], source: { kind: "skill-catalog" } }),
  ev("system/message", 5, { message: { role: "system", content: [{ type: "text", text: "You are an AI agent powered by DeepSeek Harness." }] } }),
  ev("request/header", 6, { header: { tools: [{ name: "bash", description: "run", parameters: { type: "object" } }, { name: "subagent", description: "spawn", parameters: {} }] } }),
  ev("assistant/message", 1000, { message: { id: "r1", role: "assistant", content: [
    { type: "reasoning", text: "先列目录" }, { type: "text", text: "我看看" },
    { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls","description":"列目录"}' },
    { type: "tool-call", id: "c2", name: "subagent", arguments: '{"description":"查资料","prompt":"去查"}' },
  ], source: { model: "deepseek-flash" } }, usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50 } }),
  ev("tool/result", 3000, { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "a.md" }], isError: false } }),
  ev("tool/result", 9000, { message: { role: "tool", toolCallId: "c2", content: [{ type: "text", text: "查到了" }], isError: false } }),
  ev("session/title", 9500, { title: "看目录", messageSeqs: [], source: { kind: "provider" } }),
  ev("assistant/message", 10000, { message: { id: "r2", role: "assistant", content: [{ type: "text", text: "好了" }], source: { model: "deepseek-flash" } },
    usage: { inputTokens: 20, cacheReadTokens: 1100, cacheWriteTokens: 0, outputTokens: 5 } }),
];
const child = [
  { type: "session", version: 4, id: "kid-1", createdAt: T0 + 1500, cwd: "/w/demo", parentSession: "session-demo", origin: "subagent", delegationDepth: 1 },
  ev("subagent/descriptor", 1500, { label: "查资料", agentModel: "deepseek-flash" }),
  ev("user/message", 1600, { content: [{ type: "text", text: "去查" }], source: { kind: "agent-message" } }),
  ev("assistant/message", 5000, { message: { id: "k1", role: "assistant", content: [{ type: "text", text: "查到了" }], source: { model: "deepseek-flash" } },
    usage: { inputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7 } }),
];
const put = (sid: string, evs: any[]) => {
  const d = join(SESS, "--w-demo--", sid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.v4.jsonl.zstd"), Bun.zstdCompressSync(Buffer.from(evs.map(e => JSON.stringify(e)).join("\n") + "\n")));
};

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  put("session-demo", main);
  put("kid-1", child);
});

describe("dsh 会话翻译", () => {
  test("人发的话是用户消息,dsh 注入的是附件,系统提示词和工具定义进快照,用量换成 Claude 的字段", () => {
    const lines = convert(main as any).trim().split("\n").map(l => JSON.parse(l));
    expect(lines.filter(l => l.type === "user" && typeof l.message.content === "string").map(l => l.message.content)).toEqual(["帮我看看目录"]);
    expect(lines.filter(l => l.type === "attachment").map(l => l.attachment.type)).toEqual(["environment", "skill_listing", "prompt_snapshot", "prompt_snapshot"]);
    const snap = lines.filter(l => l.attachment?.type === "prompt_snapshot").pop();
    expect(snap.attachment.tools.map((t: any) => t.name)).toEqual(["Bash", "Agent"]);
    const a = lines.find(l => l.type === "assistant");
    expect(a.message.usage).toEqual({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 });
    expect(a.message.content.map((c: any) => c.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
    expect(a.message.content[2]).toMatchObject({ name: "Bash", input: { command: "ls" } });
    expect(lines.find(l => l.type === "custom-title").customTitle).toBe("看目录");
    expect(lines.every(l => l.type === "custom-title" || l.entrypoint === "dsh")).toBe(true);
  });

  test("翻译进镜像目录、建索引:会话、用量、子 Agent、标题都对;没变化不重翻", () => {
    const r = mirrorAll([SESS], OUT);
    expect(r.n).toBe(2);
    const dir = join(OUT, "-w-demo");
    expect(existsSync(join(dir, "session-demo.jsonl"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "session-demo", "subagents", "agent-kid-1.meta.json"), "utf8"));
    expect(meta).toMatchObject({ description: "查资料", toolUseId: "c2" });
    const db = new Database(":memory:");
    indexAll(db, [OUT]);
    const s = db.query("SELECT * FROM cc_sessions WHERE id = 'session-demo'").get() as any;
    expect(s).toMatchObject({ title: "看目录", replies: 3, out_tokens: 62, in_tokens: 150, cache_read: 2000, engine: "dsh", auto: 0, subagents: 1, model: "deepseek-flash" });
    const m = parseAgentFile(join(dir, "session-demo.jsonl"), "main");
    expect(m.tools.map(t => [t.name, t.ok])).toEqual([["Bash", true], ["Agent", true]]);
    expect(mirrorAll([SESS], OUT).n).toBe(0);
  });

  test("日志追加后只读新增部分;译文前缀变了会报出来要重建", () => {
    put("session-demo", [...main, ev("user/message", 20000, { id: "m2", role: "user", content: [{ type: "text", text: "再看一次" }] })]);
    const r = mirrorAll([SESS], OUT);
    expect(r).toEqual({ n: 1, rewritten: [] });
    put("session-demo", main.slice(0, 4));
    expect(mirrorAll([SESS], OUT).rewritten).toEqual(["session-demo"]);
  });

  test("工作台派的活(会话号 session-wb-)算脚本自动", () => {
    const evs = [{ ...main[0], id: "session-wb-1" }, ...main.slice(1)];
    expect(convert(evs as any).split("\n").filter(Boolean).every(l => { const o = JSON.parse(l); return o.type === "custom-title" || o.entrypoint === "dsh-auto"; })).toBe(true);
  });
});

import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { indexAll } from "../server/indexer";
import { parseAgentFile, requestBrowser, reqCats, programOf, titleOf } from "../server/context";
import { splitUserText, messageItems, costOf, capMs, MAX_CALL_MS, est, scaleTo } from "../server/classify";

const ROOT = `/tmp/wb-ctx-fixture-${process.pid}`;
const DIR = join(ROOT, "-Users-demo-Documents-my-project");
const SID = "aaaaaaaa-0000-0000-0000-000000000001";
const F = join(DIR, `${SID}.jsonl`);
const L = (o: any) => JSON.stringify({ sessionId: SID, ...o });
const usage = (o: number) => ({ input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: o, cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 } });

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(F, [
    L({ type: "api-request-shape", shapeHash: "S", shape: { system: [{ type: "text", text: "你是助手。" }], tools: [{ name: "Bash", description: "跑命令", input_schema: {} }] } }),
    L({ type: "api-request-blob", hash: "A", message: { role: "user", content: [{ type: "text", text: "<system-reminder>项目说明很长很长</system-reminder>" }, { type: "text", text: "/clear" }] } }),
    L({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" }, timestamp: "2026-10-29T01:00:00.000Z" }),
    L({ type: "user", message: { role: "user", content: "帮我画个图" }, timestamp: "2026-10-29T01:00:01.000Z" }),
    L({ type: "api-request", id: "R1", timestamp: "2026-10-29T01:00:02.000Z", querySource: "repl_main_thread", shapeHash: "S", keep: 0, tail: ["A"], params: { model: "claude-opus-5-5" } }),
    // 同一条回复拆两行,usage 一样 → 只算一次
    L({ type: "assistant", requestRef: "R1", timestamp: "2026-10-29T01:00:05.000Z", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "", signature: "x".repeat(60) }], usage: usage(100) } }),
    L({ type: "assistant", requestRef: "R1", timestamp: "2026-10-29T01:00:06.000Z", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "F=\"a b\"; grep x y", description: "找" } }], usage: usage(100) } }),
    L({ type: "user", timestamp: "2026-10-29T01:00:16.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "找到三行结果" }] } }),
    L({ type: "api-request-blob", hash: "B", message: { role: "user", content: [{ type: "text", text: "<total_tokens>999 tokens left</total_tokens>" }] } }),
    L({ type: "api-request", id: "R2", timestamp: "2026-10-29T01:00:17.000Z", querySource: "repl_main_thread", shapeHash: "S", keep: 1, tail: ["缺1", "缺2", "B"], params: { model: "claude-opus-5-5" } }),
    L({ type: "assistant", requestRef: "R2", timestamp: "2026-10-29T01:00:20.000Z", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "画好了" }], usage: usage(50) } }),
    L({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-29T01:00:30.000Z", compactMetadata: { trigger: "auto", preTokens: 900000, postTokens: 20000, durationMs: 5000 } }),
    L({ type: "system", subtype: "turn_duration", durationMs: 25000, timestamp: "2026-10-29T01:00:31.000Z" }),
    // 老版本:没有请求记录、没有 requestRef
    L({ type: "assistant", timestamp: "2026-10-29T01:01:00.000Z", message: { id: "m3", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "老格式回复" }], usage: usage(7) } }),
    "",
  ].join("\n"));
});

describe("分类", () => {
  test("提醒、余量提示、环境信息、命令外壳都算注入,只有真打的字算用户", () => {
    expect(splitUserText("<system-reminder>x</system-reminder>你好").map(i => i.cat)).toEqual(["inject", "user"]);
    expect(splitUserText("<total_tokens>9 left</total_tokens>")[0]).toMatchObject({ cat: "inject", kind: "余量提示" });
    expect(splitUserText("# Environment\nYou have been invoked")[0].kind).toBe("环境信息");
    expect(splitUserText("<system-reminder>The following skills are available for use with the Skill tool</system-reminder>")[0].cat).toBe("skill");
  });
  test("Skill 工具的返回算技能注入,其他工具返回算工具结果", () => {
    const ids = new Set<string>();
    messageItems({ role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "pdf" } }] }, ids);
    const r = messageItems({ role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "技能说明" }, { type: "tool_result", tool_use_id: "z", content: "别的" }] }, ids);
    expect(r.map(i => i.cat)).toEqual(["skill", "tool"]);
  });
  test("估算与缩放:缩放后加起来等于实际", () => {
    expect(est("你好abcd")).toBe(2 + Math.round(4 / 3.6));
    expect(scaleTo([1, 2, 3], 600).reduce((a, b) => a + b, 0)).toBe(600);
  });
  test("价格:Opus 5.5 输入 4、输出 20、缓存读 0.2,缓存写 5 分钟 1.25 倍、1 小时 2 倍", () => {
    expect(costOf("claude-opus-5-5", { input: 1e6, read: 1e6, w5: 1e6, w1h: 1e6, output: 1e6 })).toBeCloseTo(4 + 0.2 + 5 + 8 + 20, 5);
    expect(costOf("未知模型", { input: 1, read: 0, w5: 0, w1h: 0, output: 0 })).toBeNull();
  });
  test("单次调用时长最多按 30 分钟算", () => expect(capMs(3 * 3600_000)).toBe(MAX_CALL_MS));
  test("命令名:去掉变量赋值和 cd", () => {
    expect(programOf('F="a b/记录.md"; grep x "$F"')).toBe("grep");
    expect(programOf('cd "/x y" && A=1 bun test')).toBe("bun");
    expect(programOf("unset CLAUDECODE; claude -p hi")).toBe("claude");
    expect(programOf("set -e; cd x && git status")).toBe("git");
  });
});

describe("请求级索引", () => {
  test("两次请求入库;同一回复多行的用量只算一次;没请求记录的老回复也补一条", () => {
    const db = new Database(":memory:");
    indexAll(db, ROOT);
    const rows = db.query("SELECT * FROM cc_requests ORDER BY at").all() as any[];
    expect(rows.map(r => r.id)).toEqual(["R1", "R2", "m3"]);
    expect(rows[0].output).toBe(100);
    expect(rows[0].w1h).toBe(30);
    expect(rows[0].w5).toBe(60);
    expect(rows[0].tool_ms).toBe(10_000);
    expect(rows[2].source).toBe("legacy");
    // 第二次请求的上下文 = 第一条消息 + 上次回复 + 工具返回 + 余量提示
    expect(rows[1].msgs).toBe(4);
    expect(rows[1].e_assistant).toBeGreaterThan(0);
    expect(rows[1].e_tool).toBeGreaterThan(0);
    expect((db.query("SELECT sum(out_tokens) o FROM cc_sessions").get() as any).o).toBe(157);
  });
});

describe("会话深度解析", () => {
  const m = () => parseAgentFile(F, "main");
  test("标题跳过斜杠命令", () => expect(titleOf(m())).toBe("帮我画个图"));
  test("还原第二次请求:各类条目齐全,缩放后合计等于实际输入", () => {
    const mm = m();
    const b = requestBrowser(mm, 1)!;
    const g = Object.fromEntries(b.groups.map(x => [x.cat, x]));
    expect(g.system.count).toBe(1);
    expect(g.tools.count).toBe(1);
    expect(g.assistant.count).toBe(2); // 思考 + 工具调用
    expect(g.tool.count).toBe(1);
    expect(g.inject.items.map((i: any) => i.kind)).toContain("余量提示");
    expect(b.total).toBe(1000);
    expect(reqCats(mm, mm.reqs[1]).actual).toBe(1000);
    expect(g.tool.added).toBe(1); // 和第一次比,工具返回是新加的
  });
  test("压缩事件、工具耗时、活跃时长", () => {
    const mm = m();
    expect(mm.events.find(e => e.kind === "compact")?.text).toBe("自动压缩：900k → 20k");
    expect(mm.tools[0]).toMatchObject({ name: "Bash", ms: 10_000, ok: true });
    expect(mm.activeMs).toBe(25000);
  });
});

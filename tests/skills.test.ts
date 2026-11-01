/** 会话里用到的技能:模型调用、斜杠命令、压缩后重新带上、老格式、子 Agent */
import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { parseAgentFile } from "../server/context";

const ROOT = `/tmp/cc-skills-${process.pid}`;
const ts = (s: number) => new Date(Date.UTC(2026, 9, 31, 1, 0, s)).toISOString();
const L = (o: any) => JSON.stringify({ sessionId: "k", ...o });
const body = (name: string) => `Base directory for this skill: /Users/demo/.claude/skills/${name}\n\n# ${name}\n` + "技能说明。".repeat(200);
let uses: any[];
beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "k.jsonl"), [
    L({ type: "user", timestamp: ts(1), message: { role: "user", content: "做个图表" } }),
    L({ type: "assistant", requestRef: "R1", timestamp: ts(3), message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "dataviz", args: "折线图" } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
    L({ type: "user", timestamp: ts(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "Launching skill: dataviz" }] } }),
    L({ type: "user", isMeta: true, sourceToolUseID: "s1", timestamp: ts(4), message: { role: "user", content: [{ type: "text", text: body("dataviz") }] } }),
    // 你打的斜杠命令
    L({ type: "user", timestamp: ts(20), message: { role: "user", content: "<command-name>/web-access</command-name><command-args>查一下天气</command-args>" } }),
    L({ type: "user", isMeta: true, timestamp: ts(20), message: { role: "user", content: [{ type: "text", text: body("web-access") }] } }),
    // 老格式:技能全文在工具返回里
    L({ type: "assistant", requestRef: "R2", timestamp: ts(30), message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "pdf" } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
    L({ type: "user", timestamp: ts(31), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s2", content: body("pdf") }] } }),
    // 压缩后重新带上
    L({ type: "attachment", timestamp: ts(40), attachment: { type: "invoked_skills", skills: [{ name: "dataviz", path: "x", content: body("dataviz") }] } }),
    "",
  ].join("\n"));
  uses = parseAgentFile(join(ROOT, "k.jsonl"), "main").skillUses;
});

test("四次使用都认出来,顺序按时间", () => expect(uses.map(u => `${u.name}/${u.via}`)).toEqual(["dataviz/模型调用", "web-access/斜杠命令", "pdf/模型调用", "dataviz/压缩后重新带上"]));
test("模型调用:参数和全文都对上(按 sourceToolUseID)", () => {
  expect(uses[0].args).toBe("折线图");
  expect(uses[0].tokens).toBeGreaterThan(900);
  expect(uses[0].path).toBe("/Users/demo/.claude/skills/dataviz");
});
test("斜杠命令:名字和参数取自你打的命令", () => { expect(uses[1].name).toBe("web-access"); expect(uses[1].args).toBe("查一下天气"); expect(uses[1].tokens).toBeGreaterThan(900); });
test("老格式:全文从工具返回里取", () => expect(uses[2].tokens).toBeGreaterThan(900));
test("技能全文那条消息不算你说的话", () => expect(parseAgentFile(join(ROOT, "k.jsonl"), "main").prompts.map(p => p.text)).toEqual(["做个图表", "/web-access 查一下天气"]));

import { test, expect } from "bun:test";
import { buildTable } from "../server/prices";
import { priceOf, setOpenPrices } from "../server/classify";

test("别家模型按公开价目表算价：原厂优先，0 元套餐排后，Claude 仍用内置价", () => {
  setOpenPrices(buildTable({
    "302ai": { models: { "deepseek-flash": { cost: { input: 0.2, output: 0.8, cache_read: 0.01 } } } },
    deepseek: { models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    plan: { models: { "glm-5.3": { cost: { input: 0, output: 0 } } } },
    zhipuai: { models: { "glm-5.3": { cost: { input: 1, output: 4 } } } },
    anthropic: { models: { "claude-opus-5-5": { cost: { input: 99, output: 99 } } } },
  }));
  expect(priceOf("deepseek-flash")).toEqual({ in: 0.15, out: 0.6, read: 0.003 });
  expect(priceOf("glm-5.3")).toEqual({ in: 1, out: 4, read: 1 });
  expect(priceOf("claude-opus-5-5[1m]")!.in).toBe(4);
  expect(priceOf("deepseek-chat")).toEqual({ in: 0.15, out: 0.6, read: 0.003 });
  expect(priceOf("没有这个模型")).toBeNull();
});

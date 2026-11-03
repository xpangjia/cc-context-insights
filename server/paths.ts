import { homedir } from "os";
import { join } from "path";

export const HOME = homedir();
export const ROOT = join(import.meta.dir, "..");
/** Claude Code 会话日志所在目录(只读) */
export const CC_ROOT = process.env.CLAUDE_PROJECTS_DIR ?? join(HOME, ".claude/projects");
/** 本工具自己的索引库放这里,删掉会自动重建 */
export const DATA_DIR = process.env.CC_INSIGHTS_DATA ?? join(HOME, ".cc-context-insights");
/**
 * DeepSeek Harness 会话目录(只读),冒号分隔可以写多个;默认 ~/.dsh/sessions(有才读)。
 * 读到的会话翻译成 Claude Code 日志格式放进 DSH_MIRROR,跟 Claude Code 的会话一起统计。
 */
export const DSH_DIRS = (process.env.DSH_SESSIONS_DIRS ?? join(HOME, ".dsh/sessions")).split(":").filter(Boolean);
export const DSH_MIRROR = join(DATA_DIR, "dsh-mirror");
/** 会话日志的全部来源:Claude Code 自己的 + dsh 翻译过来的 */
export const LOG_ROOTS = [CC_ROOT, DSH_MIRROR];
export const PORT = Number(process.env.PORT ?? 18450);

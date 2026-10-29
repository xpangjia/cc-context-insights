import { homedir } from "os";
import { join } from "path";

export const HOME = homedir();
export const ROOT = join(import.meta.dir, "..");
/** Claude Code 会话日志所在目录(只读) */
export const CC_ROOT = process.env.CLAUDE_PROJECTS_DIR ?? join(HOME, ".claude/projects");
/** 本工具自己的索引库放这里,删掉会自动重建 */
export const DATA_DIR = process.env.CC_INSIGHTS_DATA ?? join(HOME, ".cc-context-insights");
export const PORT = Number(process.env.PORT ?? 18450);

# Claude Code 上下文洞察

看清 Claude Code 每个会话里**上下文装了什么、花了多少、时间耗在哪、派了哪些子 Agent**。一个本地网页，只读你电脑上的会话日志，数据不出这台电脑。

灵感来自 DeepSeek Harness 的插件 [dsh-context](https://github.com/bowenliang123/dsh-context)，页面设计参考了它，代码是重新写的。

## 一键运行

需要 [bun](https://bun.sh)（装一次就行）：

```bash
curl -fsSL https://bun.sh/install | bash
```

然后：

```bash
git clone https://github.com/xpangjia/cc-context-insights.git
cd cc-context-insights
./start.sh          # 或者 bun start
```

浏览器会自动打开 http://127.0.0.1:18450 。第一次要建索引，几秒到一两分钟（看你的会话日志有多大）。之后每 2 分钟自动更新。

不用 `bun install`：运行时不依赖任何第三方包，前端已经构建好放在 `web/dist`。

## 能看什么

**上下文洞察（首页）**：选今天 / 近 7 天 / 近 30 天 / 全部

- 会话数、Token 消耗、估算费用、缓存命中率、工具调用、活跃时长
- 近 7 天每天的用量
- Token 组成环：系统提示词、工具定义、用户消息、注入内容、技能注入、助手消息、工具结果、输出各占多少
- 耗时环：模型调用和工具执行各花了多少时间
- 8 周活跃热力图、技能加载次数
- 会话卡片：每个会话当前上下文的组成小环、轮次步数、Token、费用、最后一句

**搜会话**：页头的搜索框随时可用，按 `/` 聚焦。不分时间范围，搜标题、你在会话里说过的任何一句话、启动目录、会话 id；空格分开的几个词要同时命中。↑↓ 选，回车打开。

**会话详情**：点任意会话卡片或搜索结果进去

- **上下文**：统计、Token 和耗时组成、当前上下文占窗口多少、上下文浏览器（任选一次请求，按类展开到每一条看原文，标出比上一次新加的）、上下文趋势（每次请求一根柱子，全量 / 增量，标出压缩和清理）、上下文事件、文件活动、命令执行。派了子 Agent 的会话可以切换看每个子 Agent 的上下文。
- **轨迹**：按时间看每一步：输入、回复、思考、工具调用和结果、子 Agent 完成通知；顶部时间带看输入 / 模型 / 工具在什么时候活动。
- **编队**：Agent 网络、成员、任务、通讯记录（派活和回报一一对应）。

## 数字是怎么来的

- Claude Code 在 `~/.claude/projects/` 下的会话日志里存着每次发给模型的完整请求（系统提示词、工具定义、每条消息）。这里把每次请求原样还原，按七类拆开。
- 各类的 token 先按字数估（中文 1 字约 1 个，其他约 3.6 个字符 1 个），再按日志里官方计量的实际输入**等比换算**，所以各类加起来等于实际值。
- 较早版本的 Claude Code 不记录请求内容，那些会话只能算总量、拆不开类别，页面上会写明占比。
- 费用按 Anthropic 官方价估算（如 Opus 5.5 输入 $4 / 输出 $20 每百万 token，缓存读 $0.2，缓存写入按输入价 1.25 倍 / 1 小时缓存 2 倍）。你实际走订阅或代理的话，真实花费不同。
- 计时：单次调用最多按 30 分钟算（更长多半是电脑休眠或在等确认）；派子 Agent 的那次调用不计工具时长，子 Agent 自己的时间另算。

## 设置（都可以不管）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 18450 | 网页端口 |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code 会话日志目录 |
| `CC_INSIGHTS_DATA` | `~/.cc-context-insights` | 本工具的索引库，删掉会自动重建 |
| `NO_OPEN` | 不设 | 设成 1 就不自动开浏览器 |

## 嵌进你自己的页面

可以用 iframe 把它嵌进你自己的看板：

```html
<iframe src="http://127.0.0.1:18450/" style="width:100%;height:80vh;border:0"></iframe>
<iframe src="http://127.0.0.1:18450/session?id=<会话 id>&tab=context&bare=1" style="width:100%;height:80vh;border:0"></iframe>
```

- 被嵌入时自动隐藏自己的页头和页脚，搜索框挪到页面标题右边。
- 内容高度会通过 `postMessage` 发给宿主（`{ source: "cc-context-insights", type: "height", h }`），宿主把 iframe 设成这个高度，整页就只有一个滚动条；在里面换页时还会发 `{ type: "nav" }`，宿主可以借此滚回 iframe 顶部。
- 会话页的 `tab` 可以是 `context`（上下文）、`trace`（轨迹）、`fleet`（编队）。
- 加 `bare=1` 会再隐藏会话信息卡，适合宿主页面已经显示了会话标题的情况。

## 隐私

- 只读 `~/.claude/projects` 下的日志，不改、不上传，网页只监听 127.0.0.1（别的电脑访问不到）。
- 索引存在 `~/.cc-context-insights/index.db`，里面有会话标题和你说过的话（用来搜索，每句最多存 600 字），分享截图或这个文件时注意。

## 开发

```bash
bun install          # 只有改前端才需要
bun run dev:web      # 前端开发（18451，/api 转到 18450）
bun run build        # 重新构建前端到 web/dist
bun test             # 单元测试
```

代码结构：

| 文件 | 干什么 |
|---|---|
| `server/indexer.ts` | 后台增量索引：每个日志文件记住读到哪，下次只读新的部分 |
| `server/context.ts` | 单个会话的深度解析：还原每次请求、轨迹、文件、命令、编队、通讯 |
| `server/classify.ts` | 七类分类、token 估算、价格 |
| `server/insights.ts` | 首页统计 |
| `web/src/pages/` | 页面；`web/src/components/` 图表 |

## 已知限制

- 界面只有中文。
- 数据是读日志来的，不是实时的：最多晚 2 分钟。
- 需要 Claude Code 新版本才有逐次请求的上下文记录；老会话只有总量。

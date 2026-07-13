# server/adapters/
> L2 | 父级: ../CLAUDE.md

各 Agent 工具的会话存储适配器。契约：输入 mtime 缓存，输出统一 Session 模型数组
{key, tool, id, cwd, gitBranch, title, firstPrompt, createdAt, updatedAt, sizeBytes, turns, status, filePath}。
新接入一个工具 = 新增一个文件 + scanner 一行 import，别无他求。

成员清单
shared.mjs: 公共解析原语，headLines/tailText 首尾局部读取(永不全量加载)、cleanPrompt 提示词清洗、classifyStatus 状态分类(active/dead/stale/tiny/archived)
claude.mjs: Claude Code 适配器，扫 ~/.claude/projects。头部窗口取 cwd/gitBranch/firstPrompt/isSidechain；
  尾部窗口取 customTitle(用户命名,titleSource=user)/lastPrompt(标题兜底)——用户改名 append 在文件尾，头部读不到。
  合并可选 v0 存量(aliases 也是 user 源；默认 ~/BINGO-Space/Claude_Code/_session-dashboard，
  可用 AGENT_CANVAS_V0_DIR 覆盖)。单文件 stat 失败跳过(TOCTOU)
codex.mjs: Codex 适配器，扫 ~/.codex/sessions + archived_sessions，session_index.jsonl 官方索引供标题(last-wins)，
  session_meta 供 cwd 与血统(thread_source 或旧版 source.subagent)。单文件 stat 失败跳过(TOCTOU)

铁律: 解析逻辑变更必须递增 store.mjs 的 CACHE_VERSION，否则 mtime 命中的旧缓存永远吃不到新逻辑

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

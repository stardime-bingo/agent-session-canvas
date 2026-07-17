# AGENT 会话指挥塔

把 Claude Code 与 Codex 的本地会话放进一张可操作的 React Flow 画布：自动聚簇工作区、搜索与筛选、AI 摘要和接力、一键从 Ghostty 续开。

这不是在线演示站，也没有第二套页面。产品就是安装后运行在 `http://localhost:4517` 的本地实机；GitHub 仓库和插件只负责分发、安装、启动与打开它。

## 它解决什么

- 扫描 `~/.claude/projects` 与 `~/.codex/sessions`，统一成同一种会话卡片。
- 从工作区、会话状态、时间与工具维度定位上千条历史会话。
- 保留手工布局、便签、画板与连线；地图随本地会话自然生长。
- 详情同时展示会话开场与“最后停在哪里”，不用展开整份日志才能找到接手点。
- 生成摘要与接力提示词，并从原会话续开或带上下文新开。
- 过滤子智能体、空壳与 headless 自噪，automation 多次运行会自动聚合。

## 画布操作

- 空白处左键拖动：框选，不再把整张地图拖走。
- 空格 + 左键拖动，或鼠标中键拖动：平移画布。
- 触控板双指：平移；捏合或 `⌘` + 滚动：缩放。
- 街区与画板只从标题栏搬动，避免在容器空白处误拖整组成员。
- “整理”只重排位置，保留人工划入街区/画板的归属；完成后可点“撤销”或按 `⌘Z`。

## 环境要求

- macOS
- Node.js 20.19+ 或 22.12+（开发与验收使用 Node.js 22/24）
- Claude Code 或 Codex CLI 至少安装一种
- Ghostty 可选；没有时会回退到 Terminal.app

## 直接安装

```bash
git clone https://github.com/stardime-bingo/agent-session-canvas.git ~/.agent-session-canvas
cd ~/.agent-session-canvas
./scripts/install.sh
open http://localhost:4517
```

安装脚本会执行 `npm ci`、构建前端，并根据当前 checkout 与 Node 路径生成 `~/Library/LaunchAgents/com.bingo.agent-canvas.plist`。服务登录自启，固定监听本机 `4517` 端口。

## 快捷启停

仓库内提供 Finder 可双击的薄入口；它们只调用同一份 launchd 控制脚本，不复制服务逻辑：

- `scripts/启动会话指挥塔.command`
- `scripts/停止会话指挥塔.command`

命令行也可直接控制。`stop` 可重复执行，只停止服务，不删除 plist 或 `data/`；`start` 会在 plist 仍在但服务未注册时直接恢复注册，无需重新安装：

```bash
AGENT_CANVAS_HOME="$PWD" plugins/agent-session-canvas/scripts/agent-canvas status
AGENT_CANVAS_HOME="$PWD" plugins/agent-session-canvas/scripts/agent-canvas stop
AGENT_CANVAS_HOME="$PWD" plugins/agent-session-canvas/scripts/agent-canvas start
```

`status` 始终只输出一行 JSON；仅当 launchd 已注册、进程运行且 `4517` API 健康时 exit 0，其余状态 exit 1。

只读诊断：

```bash
~/.agent-session-canvas/scripts/doctor.sh
```

## 通过 Claude Code 插件安装

```bash
claude plugin marketplace add stardime-bingo/agent-session-canvas
claude plugin install agent-session-canvas@agent-session-canvas
```

安装后新开一个 Claude Code 会话，可以说：

- “安装并打开 AGENT 会话指挥塔”
- “诊断会话指挥塔为什么打不开”
- “启动并打开我的会话画布”
- “停止会话指挥塔”或“查看会话指挥塔状态”

## 通过 Codex 插件安装

```bash
codex plugin marketplace add stardime-bingo/agent-session-canvas --ref main
codex plugin add agent-session-canvas@agent-session-canvas
```

安装后新建 Codex 任务，再使用同样的自然语言指令。插件是薄控制层：它不会复制 UI，也不会自行上传会话，只调用仓库中的安装、诊断、启动与打开脚本。

## 本地数据与隐私

应用仅监听 localhost。会话原文继续留在 Claude Code / Codex 自己的目录中；本项目只在 `data/` 保存以下本地运行时数据：

- `enrich.json`：标题、摘要与接力，珍贵数据
- `canvas.json`：便签、画板、手绘与手动连线
- `layout.json`：手工布局
- `scan-cache.json`：可丢弃扫描缓存

`data/`、日志、构建产物与本机 launchd plist 都被 `.gitignore` 排除，不会进入 GitHub。

扫描、搜索、画布编辑与会话续开都在本机完成。只有当用户主动使用 AI 命名、摘要、接力或批量回填时，应用才会把提取出的会话片段交给本机已配置的 Codex、Claude Code 或可选 DeepSeek CLI；相应服务商如何处理这些内容，以用户与该服务商的账户设置和条款为准。本项目不提供账户服务，也不采集遥测或分析数据。

Claude Code 的 SessionEnd 自动接力钩子是可选系统配置，默认不安装。启用它会修改 `~/.claude/settings.json`，应先备份并由用户明确确认；普通安装与插件安装都不会偷偷开启。

## 开发

```bash
npm ci
npm test
npm run build
npm run serve
```

服务端代码修改后的正确重启方式：

```bash
launchctl kickstart -k gui/$(id -u)/com.bingo.agent-canvas
```

前端修改只需 `npm run build`，无需重启 daemon。

## 架构

- `server/`：零依赖 Node daemon、双适配器扫描、AI 路由与本地 HTTP/SSE
- `web/`：React 18 + React Flow + Excalidraw 的唯一产品界面
- `hooks/`：可选 Claude Code SessionEnd 接力钩子
- `scripts/`：安装、只读诊断与 Finder 双击启停入口
- `plugins/`：Claude Code / Codex 共用薄插件与统一 launchd 控制脚本
- `tests/`：Node 原生回归测试

## License

[MIT](./LICENSE)

Published by BINGOAI.

## Policies

- [Privacy Policy](./PRIVACY.md)
- [Terms of Use](./TERMS.md)
- [Codex marketplace submission copy](./docs/codex-marketplace-submission.md)

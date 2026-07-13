# AGENT 会话指挥塔 - 本地多工具 Agent 会话管理画布
Node.js 24 (零依赖后端) + React 18 + @xyflow/react 12 + Vite 8

> 统一扫描 Claude Code / Codex 的全部本地会话，Dify 式画布自动聚簇工作区，
> AI 摘要 + 接力提示词，一键拉起 Ghostty 终端续开/新开会话。
> 地图从地形自动生长，点击地图反向驱动地形。

<directory>
server/ - 零依赖 Node 后端 daemon (7文件 + adapters/: 扫描/拉起/模型路由/AI/回填/HTTP)
web/ - React Flow 画布前端 (src/: 总装 + ui 原子库(toast/确认/就地改名/图标) + canvas/ 画布引擎与菜单 + panels/ 三面板)
hooks/ - Claude Code SessionEnd 接力钩子 (自动生成接力提示词)
data/ - 运行时产物: scan-cache.json(可丢弃) enrich.json(珍贵) layout.json(手工布局) launch/(临时脚本)
tests/ - 零依赖 node:test 回归：增强仓跨进程写入、Codex 索引写后校验、模型 JSON/会话尾部提取、增量布局防重叠
scripts/ - 开源安装、只读诊断与发布资产准备；安装脚本按当前 checkout 生成 launchd plist，不写死个人路径；
  prepare-assets 从 lock 固定的 Excalidraw 包同步离线字体，Git 不重复 vendoring 13MB 二进制
plugins/ - Claude Code / Codex 共用的薄插件，只安装、诊断、启动、打开本地实机
docs/ + PRIVACY.md + TERMS.md - Codex 市场提交文案、隐私披露与公开使用条款
</directory>

<config>
package.json - 前端依赖与脚本 (build/serve/scan/start) + 上游精确旧依赖的安全补丁 overrides
vite.config.mjs - 前端构建: root=web, 产物 web/dist, dev 代理 :4517
</config>

## 常驻运行（launchd 守护，2026-07-13 起）

服务由 launchd 托管：登录自启、被误杀 3 秒自动复活、固定专属端口 **4517**（代码写死，非任何工具默认端口）。
日志: data/daemon.log · plist: infra/com.bingo.agent-canvas.plist（安装于 ~/Library/LaunchAgents/）

```bash
# ⚠️ 改完 server/ 代码后重启服务（唯一正确方式——kill 会被 launchd 立即拉起旧代码）:
launchctl kickstart -k gui/$(id -u)/com.bingo.agent-canvas
# 改完 web/ 代码: npm run build 即可（静态文件即时生效，无需重启）
# 卸载守护: launchctl bootout gui/$(id -u)/com.bingo.agent-canvas
npm run scan         # 仅扫描，输出统计
```

数据持久化: data/{enrich,canvas,layout}.json 磁盘常驻 + 原子写入 + 每日备份 data/backups/(保 7 天)；scan-cache 可丢弃可重建。

## 架构决策

- **Adapter 模式**: 每个 Agent 工具一个适配器输出统一 Session 模型，新增工具=新增一个文件
- **首尾局部读取**: 只读 JSONL 首 64KB + 尾 8KB，3700 文件冷扫 1.5s，mtime 缓存命中 53ms
- **三层噪音过滤**: 子智能体(claude isSidechain / codex thread_source=subagent)、空壳、headless 自噪
  全部源头滤除——40% 的文件是机器噪音，不配占卡片；automation 会话保留并打 ⚙ 标
- **模型路由 (llm.mjs)**: Codex(gpt-5.6-sol) 优先 → Claude(sonnet-5) 兜底 → DeepSeek(v4-flash) 可选，
  额度耗尽自动降级；单次精工 xhigh、批量回填 high（Max 微降一档，data/config.json 可改）
- **人话铁律**: 标题动词开头 8-16 字说人话；批量回填(backfill.mjs)只管近 30 天，历史不管
- **双仓分离**: 扫描缓存可丢弃可重建；AI 增强数据(标题/摘要/接力)与手工布局独立存放永不清扫
- **持久层并发律**: 扫描缓存进程内常驻；珍贵 enrich 更新必须锁住“读最新值→改→原子写”；Codex 索引追加后读尾校验
- **SSE 举旗不抢方向盘**: 文件变化只点亮"有新活动"按钮，用户主动刷新才重排画布
- **拖动即记忆**: 容器拖过的位置写入 layout.json，永远优先于瀑布流算法
- **成熟画布手势**: 空白左拖框选；空格+左拖/中键平移；触控板双指平移、捏合缩放；街区/画板仅标题栏搬家
- **整理只动几何**: 自动整理原子重置 x/y/w/h 但保留 layout.d 人工归属，并提供 toast 撤销与 Cmd/Ctrl+Z
- **锚点不等于重叠许可**: 手工位置优先，但新增会话/工作区令成员或容器长大时，纯布局层必须确定性顺延避让且不暗写 layout.json
- **看板归属不碰地形**: 工作区拖入另一街区/画板只改 layout.d 与画布坐标，不移动、不改写真实会话目录与文件
- **纯展示层不抢交互**: 图例等无动作覆盖层必须点击穿透，不能遮挡画布节点与入口
- **数据流单向**: 地形(~/.claude,~/.codex) → scanner → graph → 画布；画布动作 → launcher/ai → 地形

## 会话数据源

| 工具 | 位置 | 恢复命令 |
|------|------|---------|
| Claude Code | ~/.claude/projects/<转义cwd>/<uuid>.jsonl | claude --resume <id> |
| Codex | ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+archived_sessions) | codex resume <id> |

v0 存量资产 (session-manager skill 的 aliases.json + summaries/) 若存在则自动合并；路径可用 AGENT_CANVAS_V0_DIR 覆盖。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

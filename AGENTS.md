# AGENT 会话指挥塔 - 本地多工具 Agent 会话管理画布
Node.js 24（零依赖后端）+ React 18 + @xyflow/react 12 + Vite 8

> 统一扫描 Claude Code / Codex 的本地会话，自动聚簇工作区，提供 AI 摘要、接力提示词与终端续开。
> 地图从地形自动生长，点击地图反向驱动地形。

<directory>
server/ - 零依赖 Node 后端 daemon（扫描/拉起/模型路由/AI/回填/HTTP/场景快照仓与图片仓）
web/ - React Flow 前端（总装 + UI 原子库 + 画布引擎/手势/菜单 + 四面板）
hooks/ - Claude Code SessionEnd 接力钩子
data/ - 运行时产物；scan-cache 可重建，enrich/canvas/layout/drawing-files 是珍贵资产
tests/ - node:test 回归；fixtures/canvas-acceptance 覆盖 4518 挂载/拖动/交互与匿名 hero，scene-sync-acceptance 用临时 daemon 验双标签与 pagehide；archive/ 保存 v17 历史合同
scripts/ - 安装、只读诊断、快捷启停与 4518 验收服务
plugins/ - Claude Code / Codex 共用的薄插件
docs/ + PRIVACY.md + TERMS.md - 文档、市场文案、隐私披露与公开使用条款
</directory>

## 常驻运行

正式服务由 launchd 托管，固定端口 **4517**。日志在 `data/daemon.log`，plist 在
`infra/com.bingo.agent-canvas.plist`（安装到 `~/Library/LaunchAgents/`）。

```bash
# server/ 变更后唯一正确的重启方式：
launchctl kickstart -k gui/$(id -u)/com.bingo.agent-canvas
# web/ 变更只需构建，静态文件即时生效：
npm run build
# 统一控制入口：
plugins/agent-session-canvas/scripts/agent-canvas {start|stop|status}
```

`data/{enrich,canvas,layout,drawing-files}.json` 原子写入并每日备份；真实数据与 `~/.claude`、`~/.codex` 不得被测试或清理脚本改写。

## 当前架构合同

> **v18 SceneStore（2026-07-18）**：单一场景文档 + 乐观优先 + 快照持久化，处决 CAS/journal/receipt、
> 全局串行队列与多处真相。**v19 自研墨迹（同日）**：第三方绘图库整体拆除，卡片与墨迹只有一份文档、
> 一套事件和一台 React Flow 相机。旧合同只在 `tests/archive/` 与历史计划中保留。

- **交互零等待宪法**：输入路径不得等待网络、磁盘、导出或握手。写动作同步进入 SceneStore，React 直接渲染；
  300ms 后台冲刷失败时无限退避，但不阻塞输入
- **SceneStore 单一真相源**：`web/src/scene-store.js` 持有 `{ layout, edges, notes, boards, drawing, drawingFiles, seq }`；
  `mutate` 同步写入并支持 coalesce undo/redo；SSE 回声按 writerId 去重，本地干净时才 LWW 采纳
- **场景快照仓**：`server/scene.mjs` 全量 LWW + tmp/rename 原子写；同 writer 的 clientSeq 单调门拒绝 pagehide 新快照之后才落地的旧在飞请求；图片内容寻址、同 ID 不可变、资产先行引用后到，
  磁盘格式兼容旧版，升级不迁移真实资产
- **自研墨迹层**：`ink.js + InkLayer + InkTools` 直写/直出 SVG；支持笔迹、形状、箭头、文字、图片、
  框选/Shift 多选、移动、八向缩放、旋转、改样式、复制粘贴、Alt 拖复制与单笔可撤销橡皮；V/P/R/O/A/T/E 对齐常用肌肉记忆
- **单相机**：墨迹在 React Flow ViewportPortal 内，与卡片共用唯一 viewport transform；没有导出帧、冻结、预览、对齐或交接
- **容器承载**：墨迹中心落入街区/画板就随容器移动；拖动与整理都同步规划、一次 mutate，DOM 桥只负责视觉无缝衔接
- **绘图双平面**：`customData.below` 区分沉/浮层，存储仍只有一份 `canvas.drawing`；选择、命中、小地图读同一文档
- **绘图删除不藏模式**：普通模式点击描边带即可选中，Delete 删除，Esc 返回；右键支持选择、沉浮与确认删除；全部可 undo
- **交接三件套**：会话卡右键和详情面板可注入自包含 bridge-rescue 提示词并拉起终端；已生成的接力提示词明确提供 Claude Code / Codex 两个无默认接班入口，恢复血缘自动连边

## 其余不变量

- Adapter 输出统一 Session 模型；新增工具只新增适配器
- 扫描只读 JSONL 首尾局部，源头过滤子智能体、空壳与 headless 自噪，automation 保留并聚合
- AI 标题用动词开头、8–16 字说人话；批量回填只处理近 30 天
- 地形变化只举旗，不抢用户画布方向盘；手工位置永远优先于自动布局
- 空白左拖框选；空格+左拖/中键平移；触控板平移/捏合，鼠标滚轮锚定缩放
- 智能整理只动几何并保留人工归属：工作区按活跃度行对齐，街区/画板共同进入 1–4 条平衡车道，容器墨迹随行、便签不动；
  画板/街区缩放要补偿成员坐标；内容增长避碰以同一投影携带容器墨迹，下一次几何/绘图动作前 history:false 原子追平，锚点不等于重叠许可
- 画布归属只改场景文档，不移动真实会话目录与文件
- 数据流单向：`~/.claude, ~/.codex → scanner → graph → 画布 → store → 后台冲刷`

## 会话数据源

| 工具 | 位置 | 恢复命令 |
|------|------|---------|
| Claude Code | `~/.claude/projects/<转义cwd>/<uuid>.jsonl` | `claude --resume <id>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（含 archived_sessions） | `codex resume <id>` |

v0 资产（session-manager skill 的 aliases.json + summaries/）若存在会自动合并；可用 `AGENT_CANVAS_V0_DIR` 覆盖路径。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

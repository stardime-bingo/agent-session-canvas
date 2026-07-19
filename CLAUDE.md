# AGENT 会话指挥塔 - 本地多工具 Agent 会话管理画布
Node.js 24 (零依赖后端) + React 18 + @xyflow/react 12 + Vite 8

> 统一扫描 Claude Code / Codex 的全部本地会话，Dify 式画布自动聚簇工作区，
> AI 摘要 + 接力提示词，一键拉起 Ghostty 终端续开/新开会话。
> 地图从地形自动生长，点击地图反向驱动地形。

<directory>
server/ - 零依赖 Node 后端 daemon (9文件 + adapters/: 扫描/拉起/模型路由/AI/回填/HTTP/场景快照仓与图片仓)
web/ - React Flow 画布前端 (src/: 总装 + ui 原子库(toast/确认/就地改名/图标) + canvas/ 画布引擎/手势内核/菜单 + panels/ 四面板含终端框)
hooks/ - Claude Code SessionEnd 接力钩子 (自动生成接力提示词)
data/ - 运行时产物: scan-cache.json(可丢弃) enrich/canvas/layout/drawing-files.json(珍贵) launch/(临时脚本)
tests/ - 零依赖 node:test 回归：场景仓 LWW/资产先行、scene-store(合并 undo/防抖冲刷/退避/LWW 采纳)、增量布局/容器缩放、
  滚轮设备判定与缩放数学、绘图命中与选择(框选/闭包/缩放/旋转/复制)、上下文倒序分页；fixtures/canvas-acceptance 是
  4518 无数据性能(300/800 挂载红线 + 352 节点真实拖动 trace)/交互验收夹具(十五链)与匿名 README hero；scene-sync-acceptance 以临时 data dir/端口验双标签 LWW、daemon 重启与 pagehide；archive/ 存放 v17 事务机器的陪葬测试与旧夹具（归档不删除）
scripts/ - 开源安装、只读诊断、Finder 双击启停薄入口与验收服务；安装脚本按当前 checkout 生成 launchd plist，不写死个人路径；
  serve-canvas-acceptance 只绑 4518、只暴露 allowlist production/fixture dist，拒绝 /api、/data、/@fs、/.git
plugins/ - Claude Code / Codex 共用的薄插件；统一控制脚本负责安装、诊断、启停、单行 JSON 状态与打开本地实机，stop 保留 plist/data，start 可从保留 plist 恢复注册
docs/ + PRIVACY.md + TERMS.md - 文档索引、Codex 市场文案、已完成工程记录、隐私披露与公开使用条款
</directory>

<config>
package.json - 前端依赖与脚本 (build/test/serve/scan/start) + 上游精确旧依赖的安全补丁 overrides
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
# 快捷启停/状态统一走 plugins/agent-session-canvas/scripts/agent-canvas {start|stop|status}
npm run scan         # 仅扫描，输出统计
```

数据持久化: data/{enrich,canvas,layout,drawing-files}.json 磁盘常驻 + 原子写入 + 每日备份 data/backups/(保 7 天)；scan-cache 可丢弃可重建。

## 架构决策

> **v18 SceneStore（2026-07-18）**：五处真相 + CAS/journal/receipt/全局串行队列/四道门全部处决，
> 换单一场景文档 + 乐观优先 + 快照持久化。**v19 自研墨迹（同日）**：第三方绘图库整体拆除——
> 全部残余复杂度都来自"两个世界的缝"（双相机/双事件/双表征），缝没了机器就没了。
> 旧合同测试与夹具在 tests/archive/ 归档留念。

- **交互零等待宪法**: 从按下鼠标到画面响应，中间不允许出现任何一次网络、磁盘、导出、握手。
  一切写动作同步进 SceneStore；渲染（InkWorld 帧）永远只是订阅者，不是闸门；磁盘是河边取水人，永远不许筑坝
- **SceneStore 单一真相源 (web/src/scene-store.js)**: 场景文档 { layout, edges, notes, boards, drawing, drawingFiles, seq }
  唯一写入口 mutate（同步、可 coalesce 进全画布 undo/redo，容量 100）；后台防抖 300ms 全量快照冲刷，
  失败无限退避（1s→15s 封顶）永不阻塞输入，角落只亮"未同步"点；SSE 回声按 writerId 去重，本地干净才采纳（LWW）
- **场景快照律 (server/scene.mjs)**: POST /api/scene 全量快照 + tmp/rename 原子写 + 内存 rev + SSE 广播；同 writer 的 clientSeq 单调门拒绝 pagehide 新快照之后才落地的旧在飞请求；
  图片资产内容寻址、同 ID 不可变、资产先行引用后到、孤儿随场景写顺手裁剪；轻校验挡结构性垃圾，
  不做逐字节公证——磁盘格式与 v17 完全兼容（canvas/layout/drawing-files.json），备份与回滚零迁移
- **自研墨迹层 (ink.js + InkLayer + InkTools)**: 笔迹/矩形/椭圆/箭头/文字全部自写——落笔即场景文档元素、
  拖画即 coalesce mutate（一笔=一步 undo）、收笔即定稿（意外小形状判废），文字就地 textarea 击键直写；
  渲染=React 直出 SVG（沉层负 z 垫底/浮层高 z 盖顶），与卡片共用唯一 RF 相机——
  没有导出、没有帧、没有交接：文档变更到像素可见=一次 React commit；
  armed 期间滚轮直接改 RF 相机（gestures 数学复用），空格让路 RF 原生平移——单相机，冻结/预览/对齐/握手这一类问题不存在；
  选择态支持框选/Shift 多选、批量移动/八向缩放/旋转/删除/改样式、Cmd/Ctrl+C/V 与 Alt 拖复制；图片粘贴/拖入先同步占位，后台 SHA-256 内容寻址并回填既有资产仓；橡皮一笔合并成一次撤销，V/P/R/O/A/T/E 对齐 Figma 肌肉记忆，
  大实心底板收笔自动沉层 + toast 撤销；选择几何集中在 ink-selection.js 纯内核，元素结构沿用旧格式兼容子集，磁盘零迁移
- **容器承载律 (FigJam/Miro 共识)**: 墨迹中心落在街区/画板内就跟容器走——拖动乐观进行（DOM 桥 CSS 变量跟随），
  松手一次 mutate（容器新位 + 锚定墨迹平移），含平移的世界帧进 DOM 才撤桥，肉眼无缝；
  整理 applyArrange 同理：before/after 同步规划 + 一次 mutate，逆向 FLIP 桥把新 DOM 钉回旧像素后与节点同曲线 release；撤销走全局 Cmd/Ctrl+Z
- **绘图双平面**: customData.below 分沉/浮两平面（沉层负 z 垫在卡片下当背景、浮层盖顶），
  存储仍一份 canvas.drawing；沉浮切换=一次 mutate，选择环/命中/小地图全部读同一份文档
- **绘图删除不藏在模式里**: 普通模式点击描边带=选中（Delete 删，Esc 返回），右键=选中/沉浮/删除（过确认，
  可 undo）；空心形状中空区穿透给卡片，选绘图武装后封闭形状内部为热区；命中检测纯函数可证伪
- **交接三件套融合**: 会话卡右键与详情面板一键拉起 Claude 终端，注入自包含 bridge-rescue 提示词
  （bingo-agent-handoff skill），画布递精确会话地址（工具/ID/源转录/项目根/恢复命令），血缘自动连绿边
- **Adapter 模式**: 每个 Agent 工具一个适配器输出统一 Session 模型，新增工具=新增一个文件
- **首尾局部读取**: 只读 JSONL 首 64KB + 尾 8KB，3700 文件冷扫 1.5s，mtime 缓存命中 53ms
- **三层噪音过滤**: 子智能体(claude isSidechain / codex thread_source=subagent)、空壳、headless 自噪
  全部源头滤除——40% 的文件是机器噪音，不配占卡片；automation 会话保留并打 ⚙ 标
- **模型路由 (llm.mjs)**: Codex(gpt-5.6-sol，兼容 -o/stdout 最终文本) 优先 → Claude(sonnet 稳定别名) 兜底 → DeepSeek(v4-flash) 可选，
  额度耗尽自动降级；单次精工 xhigh、批量回填 high（Max 微降一档，data/config.json 可改）
- **人话铁律**: 标题动词开头 8-16 字说人话；批量回填(backfill.mjs)只管近 30 天，历史不管
- **双仓分离**: 扫描缓存可丢弃可重建；AI 增强数据(enrich)与场景文档独立存放永不清扫
- **SSE 举旗不抢方向盘**: 地形变化只点亮"有新活动"按钮，用户主动刷新才重排画布；场景回声静默采纳
- **拖动即记忆**: 容器拖过的位置写入场景文档 layout，永远优先于瀑布流算法
- **成熟画布手势**: 空白左拖框选；空格+左拖/中键平移；触控板双指平移、捏合缩放；街区/画板仅标题栏搬家
- **滚轮双模 (gestures.js)**: 逐事件判定设备——wheelDelta 120 倍数/行模式=鼠标→光标锚定缩放；二维/亚像素增量=触控板→平移；
  150ms 手势连续性防惯性误判；Ctrl/Meta/Shift 与捏合全交还 RF 原生；缩放条第四钮 自动/触控板/鼠标 三态兜底(localStorage 记忆)
- **整理只动几何**: 自动整理原子重置 x/y/w/h 但保留 layout.d 人工归属；撤销走全局 undo，一次撤一步
- **锚点不等于重叠许可**: 手工位置优先，但新增会话/工作区令成员或容器长大时，纯布局层必须确定性顺延避让且不暗写 layout
- **缩放只改画框**: 从左/上放大街区或画板时，持久化 React Flow 已补偿的子项相对坐标，重建后成员绝对位置不跳
- **落空连线有去处**: 只认明确拖线；松在画布落点弹选择——会话卡拉出的线首选"打开会话上下文"终端窗
  （倒序分页 GET /api/context-page：打开停最新、上滑翻至会话开头、content-visibility 原生虚拟化，
  5.7GB 会话与 100KB 同速打开）；连接点命中区按缩放保持 12–28px
- **看板归属不碰地形**: 工作区拖入另一街区/画板只改场景 layout.d 与画布坐标，不移动真实会话目录与文件
- **纯展示层不抢交互**: 图例等无动作覆盖层必须点击穿透，不能遮挡画布节点与入口
- **数据流单向**: 地形(~/.claude,~/.codex) → scanner → graph → 画布；画布动作 → store → 冲刷 → 磁盘；launcher/ai → 地形

## 会话数据源

| 工具 | 位置 | 恢复命令 |
|------|------|---------|
| Claude Code | ~/.claude/projects/<转义cwd>/<uuid>.jsonl | claude --resume <id> |
| Codex | ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+archived_sessions) | codex resume <id> |

v0 存量资产 (session-manager skill 的 aliases.json + summaries/) 若存在则自动合并；路径可用 AGENT_CANVAS_V0_DIR 覆盖。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

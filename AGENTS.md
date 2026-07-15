# AGENT 会话指挥塔 - 本地多工具 Agent 会话管理画布
Node.js 24 (零依赖后端) + React 18 + @xyflow/react 12 + Vite 8

> 统一扫描 Claude Code / Codex 的全部本地会话，Dify 式画布自动聚簇工作区，
> AI 摘要 + 接力提示词，一键拉起 Ghostty 终端续开/新开会话。
> 地图从地形自动生长，点击地图反向驱动地形。

<directory>
server/ - 零依赖 Node 后端 daemon (9文件 + adapters/: 扫描/拉起/模型路由/AI/回填/HTTP/画布动作与图片仓)
web/ - React Flow 画布前端 (src/: 总装 + ui 原子库(toast/确认/就地改名/图标) + canvas/ 画布引擎/手势内核/菜单 + panels/ 四面板含终端框)
hooks/ - Claude Code SessionEnd 接力钩子 (自动生成接力提示词)
data/ - 运行时产物: scan-cache.json(可丢弃) enrich/canvas/layout/drawing-files.json(珍贵) launch/(临时脚本)
tests/ - 零依赖 node:test 回归：持久层并发、尾部停止点、增量布局/容器缩放、图片资产、落空连线原子创建、滚轮设备判定与缩放数学、
  绘图命中(线段/旋转/描边带)、上下文倒序分页(无重叠无丢行)；fixtures/canvas-acceptance 是 4518 无数据性能/交互验收夹具
scripts/ - 开源安装、只读诊断与发布资产准备；安装脚本按当前 checkout 生成 launchd plist，不写死个人路径；
  prepare-assets 从 lock 精确固定的 Excalidraw 包同步离线字体，verify-subset-worker-build 递归守住 worker 闭包；serve-canvas-acceptance 只绑 4518 且拒绝 /api
plugins/ - Claude Code / Codex 共用的薄插件，只安装、诊断、启动、打开本地实机
docs/ + PRIVACY.md + TERMS.md - Codex 市场提交文案、隐私披露与公开使用条款
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
npm run scan         # 仅扫描，输出统计
```

数据持久化: data/{enrich,canvas,layout,drawing-files}.json 磁盘常驻 + 原子写入 + 每日备份 data/backups/(保 7 天)；scan-cache 可丢弃可重建。

## 架构决策

> **v17 绘图融合根治进行中**：第一轮 LE-001～LE-007 的单相机方向保留，但 Review 已证实 rendered/hit revision、局部分组/z-order、相机输入盾、容器实时承载、草稿与资产持久化还有 P1 裂缝。唯一执行计划是 `docs/绘图融合根治计划-v2.md`；LE-008～LE-014 全绿前不得宣告根治。

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
- **滚轮双模 (gestures.js)**: 逐事件判定设备——wheelDelta 120 倍数/行模式=鼠标→光标锚定缩放；二维/亚像素增量=触控板→平移；
  150ms 手势连续性防惯性误判；Ctrl/Meta/Shift 与捏合全交还 RF 原生；缩放条第四钮 自动/触控板/鼠标 三态兜底(localStorage 记忆)
- **原生绘图可编辑**: “选绘图/画笔”是显式双入口，选择态保留 Excalidraw 原生描边/背景/透明度/图层属性岛并按导航宽度让位；激活时全局动作不退场；图片 BinaryFiles 独立落 drawing-files.json，删除图片时同步裁剪孤儿资产
- **绘图双平面（committed 世界 + 目标事务）**: 已提交绘图按 customData.below 分成沉/浮两张静态 SVG，通过 React Flow ViewportPortal
  与卡片共用唯一 viewport transform；平移/缩放不再驱动 Excalidraw 或重导出。沉/浮面各自按 z-order 每 48 元素连续切组，以顺序+元素版本/几何/层级+本组图片标量签名；ready 组直接复用，同槽同签名在途组 join 同一 Promise，只导出真正 dirty 组。所有几何组跳过字体内联；整帧可见文字按字体族+去重字符集生成顺序无关签名，单独经公开 exportToSvg 抽出唯一 font capsule，字体 ready/in-flight 与 groups 全部就绪后一次 React commit 原子交接；同内容 revision 前进零导出但照常 ready。选绘图先进入普通平面待选态，命中后只把目标的容器/绑定/分组/画框递归关系闭包交给临时编辑器；新绘图从空事务开始，绝不把全场抬到卡片上。
  committed 世界编辑时持续在场，只 hole-punch 事务 originalIds；局部 draft 水合后仍先隐藏，hole SVG 进入 DOM 的 layout effect 才同步显现。尚未显现、不可交互的 opening draft 没有用户改动主权，任何退出都在 flush/落盘/closing 前直接取消并恢复 committed 世界；每次 opening 另有唯一 request 身份，上一代迟到的 drain/失败/帧回调不得触碰下一代。已显现事务的退出由 FlowCanvas 把 draft 合并回全量基线并经串行队列落盘，成功即把本轮 draft IDs 并入事务所有权并 rebase merged 基线，完整 merged SVG 进入 DOM 后同一帧卸载 draft，并只在 request 身份仍匹配时收口残留 opening Promise；失败保留洞、编辑现场与最后成功基线，回执严格区分“未落盘”与“已保存但画面交接失败”，DrawLayer 永不直存局部副本。
  编辑态导航是独立相机事务：第一个 wheel/空格拖/中键/手工具意图先阻断 Excalidraw，freeze draft 并用第二个 InkWorldLayer 静态预览接管；预览 DOM ready 后才逐事件改唯一 RF viewport，180ms 尾部只同步 align Excalidraw 一次，双 rAF token 握手后同一 commit 恢复 live/撤预览。wheel 对外部功能件放行，对 Excal textarea/Island 只断传播保留默认滚动，绘图面才进 RF 相机；缩放快捷键与 Safari gesture 也在 root capture 阻断 Excal 全局监听并只产出 RF viewport，文字普通字符与 Excal UI 默认行为保留。window pointer 监听是幂等资源，finish/reset/exit/unmount 均无条件回收。新手势可抢占过期 resume；freezing 退出丢弃未 ready preview，只有 suspended/resuming 预览可填 closing 洞；IME 同周期只 freeze/提示一次，compositionend 解锁。
  首次 new 事务里，本次 primary/左键手势新增且达到宽≥400、高≥300、面积≥120000 的实心 rectangle/ellipse/diamond，在 pointerup 后等 Excal change 稳定两帧即只 signal 一次既有 exitDrawing；selection、透明/小形状、旧元素编辑、IME 与已 rebase 事务不自动退场。唯一提交链再写入 below=true，绑定文字随宿主沉层，完整静态帧交接成功后 toast 提供按成功代际守卫的整快照撤销。屏幕 worldOverride、提交队列与持久化 props 三真相只在 idle 且 props 同引用追上 override 或当前队列快照时收口；撤销上屏前稳定排空等待期间追加的 tail，并在函数式换屏瞬间复核无 pending、代际与编辑门，后续成功不覆盖、后续失败仍恢复。普通态绘图动作串行提交，每笔到队首才基于上一成功快照变换，失败不推进基线也不毒死后续。沉层点击让位卡片，浮层命中仍跟着视觉顺序
- **容器承载律 (FigJam/Miro 共识)**: 墨迹中心落在街区/画板内就跟容器走——容器拖动、自动整理、撤销整理三路都量差平移锚定墨迹
  （面积小者优先认领，绑定标签随宿主）；小地图画一切：MiniMapInk 镜像 minimap 的 svg viewBox 把区域底板与批注投进缩略图（Miro 式地标定向）
- **绘图删除不藏在模式里**: 普通模式点击绘图描边带=一键进选绘图并选中（Delete 即删，Esc 返回），右键绘图=“选中编辑/删除此绘图”（删除过确认、即时落盘）；pane 与一切节点同河——含会话卡/工作区（视觉最上层者赢，按钮/输入/nodrag 功能件/连接点/拖动把手除外）；空心形状中空区穿透给底下卡片，命中检测是纯函数可证伪
- **整理只动几何**: 自动整理原子重置 x/y/w/h 但保留 layout.d 人工归属；每次成功整理覆盖旧票据，toast 与 Cmd/Ctrl+Z 只撤最近一步
- **锚点不等于重叠许可**: 手工位置优先，但新增会话/工作区令成员或容器长大时，纯布局层必须确定性顺延避让且不暗写 layout.json
- **缩放只改画框**: 从左/上放大街区或画板时，持久化 React Flow 已补偿的子项相对坐标，重建后成员绝对位置不跳
- **落空连线有去处**: 只认明确拖线（关闭点击续连暗状态）；松在 pane、容器空白面或边等画布落点都弹选择——
  会话卡拉出的线首选“打开会话上下文”终端窗（倒序分页 GET /api/context-page：打开停最新、上滑翻至会话开头、
  content-visibility 原生虚拟化，5.7GB 会话与 100KB 同速打开；右键菜单同河），其余“便签/画板”与手动边一次原子写入；
  连接点命中区按缩放保持 12–28px，视觉圆点独立且悬停不位移
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

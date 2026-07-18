# web/
> L2 | 父级: ../CLAUDE.md

React Flow 画布前端。**岛屿架构（v15）：画布即世界满屏铺底，一切 UI 都是漂浮岛（.island 同族皮肤）**——
左=导航岛(品牌/搜索/过滤/清单)、顶中=常驻画布工具岛(选绘图/画笔激活后 Excalidraw 工具栏进驻上方)、右上=动作岛、右=详情岛。
Dify 浅色基因：Dify 蓝 #155eef 锚点，Claude 橙 / Codex 青绿作工具身份色。

**v18 SceneStore 合同（2026-07-18）**：数据单向流 = graph 地形 + 场景文档 doc → 过滤管道 → 画布/面板；
一切写动作同步 `store.mutate`，磁盘由 store 后台防抖冲刷（失败无限退避、永不阻塞输入）。
交互零等待宪法：从按下鼠标到画面响应，中间不允许出现任何一次网络、磁盘、导出、握手。
渲染（InkWorld 帧）永远只是订阅者：拖动/整理/开绘图从不等帧，DOM 桥与显形逻辑在帧追上时收尾。
全画布 undo/redo（Cmd/Ctrl+Z / Shift+Cmd+Z）出自单一文档的历史栈，画笔流/打字流 coalesce 为一步。

丝滑四律：节点状态交还 React Flow、全量渲染不做视口裁剪(平移=纯 GPU 变换)、
动画只走合成器且平移中暂停(.canvas-moving)、已提交绘图与节点同在 React Flow viewport 内共用唯一 transform。
画布手势：空白左拖=框选，空格+左拖/中键=平移，触控板双指=平移、捏合=缩放，鼠标滚轮=光标锚定缩放
（gestures.js 逐事件判定设备；缩放条第四钮三态兜底）；街区/画板仅标题栏可整块搬家。
对象拖动语义：会话卡固定 → 工作区在容器内自由整理(拖动中目标容器高亮，只改看板归属不动本地文件) → 标题栏搬动街区/画板。
增量布局铁律：手工位置是优先锚点但不是重叠许可；后方成员/容器必须确定性顺延避让，且只在渲染态消碰撞。

**交互五律（v16 立法，v18 仍是宪法）**：
① 每一次点击必有可感知回应——选中态/菜单/提示三选一；
② 原生 alert/confirm/prompt 零容忍——改名走 InlineEdit，确认走 confirmPop，回执走 toast；
③ 删除主权律——Backspace/Delete 只对便签/画板/手动边生效，写了字的便签与画板过确认；
④ 藏起来必须给入口——工作区折叠有"展开其余 N 条"，搜索时自动全量直显；
⑤ 不可逆动作必过确认——删会话(活跃门禁)/删画板/删有字便签；绘图删除可全局 undo。

成员清单
index.html: 入口壳
src/main.jsx: 挂载点，只挂载不做逻辑
src/App.jsx: 总装线——graph 地形状态 + SceneStore 创建/采纳（SSE 场景回声按 WRITER_ID 去重，本地干净才采纳）+
  过滤管道(工具/状态/时间/搜索) + 对象动作分发（便签/画板/边/落空连线全部同步 mutate，便签打字 coalesce）+
  整理（tidy 规划交 FlowCanvas.applyArrange 一次 mutate，撤销走全局 undo）+ 全局快捷键（含 Cmd+Z/Shift+Cmd+Z）+
  画布终端框(ContextFrame)开合 + pagehide 冲刷兜底 + 空态指路牌
src/scene-store.js: 场景真相源——createSceneStore：同步 mutate/订阅/undo/redo(coalesce, 容量100)、
  防抖 300ms 后台冲刷（files delta 先行、失败 1s→15s 无限退避、在飞期追加自动追赶）、adoptRemote LWW、flushNow
src/api.js: 数据访问唯一通道——graph/session/contextPage/AI/launch + putScene 场景快照/putDrawingFiles 资产 + WRITER_ID + subscribeEvents
src/util.js: 展示工具箱——relTime/shortPath/fmtSize/classifyDigestLine + handoffSkillPrompt(交接三件套自包含提示词) + TOOL_META/STATUS_META
src/ui.jsx: UI 原子库——Icon 单色 SVG 集、toast polite status（动作按钮可键盘触发）/confirmPop() 单例 + <UIHost/>、<InlineEdit/> 就地改名
src/theme.css: 视觉唯一真相源(Dify tokens)；节点皮肤类化 + toast/confirm/空态/边tooltip/drop-target 样式；
  tool-island 三组岛、cold/retrying/stale 帧状态 chip、over-drawing 悬停提示、ink-carry-anchor 承载桥位移——全部合成器动画
src/canvas/FlowCanvas.jsx: 画布引擎总装（≤1000 行）——统一容器模型、归属律 layout.d>路径推断、容器弹性生长、
  边半受控(手动边可选可删系统边只观察)、onBeforeDelete 删除治理、折叠展开、就地改名信号、视口 localStorage 记忆、
  容器承载=乐观拖动+DOM 桥跟随+松手一次 mutate+帧追上撤桥（Escape 取消弹回）、applyArrange 同步规划一次 mutate、
  普通模式绘图命中（pane/一切节点同一条河、HIT_BLOCK 功能件排除、节点上只认浮层/pane 先浮后沉、
  待选态封闭形状内部热区）、右键沉浮/删除（可 undo）、落空连线选择菜单、连接点缩放感知、
  世界装配 world={doc.drawing, files, excludedIds, seq} 交 InkWorldLayer、4518 只读探针 seam
src/canvas/drawing-session.jsx: 绘图会话心脏——同步 openDrawing（closure 事务/armSelect 待选态）、
  onChange 防抖 140ms 连续合并进 store（coalesce 'draw'，语义键剔除 Excal 内务字段与 null≡[] 同义词，
  空手进出零污染）、打开等洞帧/退出等全量帧（600ms 兜底）同 commit 显形/卸载、首笔大底板自动沉层+撤销 toast、
  IME 组字期滞后退出、pagehide 合并冲刷、sessionPhaseRef(idle/opening/live/exiting) 供相机
src/canvas/drawing-camera.jsx: 编辑态导航独立相机（v17 机制原样移植）——首个意图 freezeDraft→静态预览接管→
  逐事件 RF viewport→180ms 尾部对齐→双 rAF 恢复 live；wheel 三路路由/缩放键/Safari gesture/空格与中键平移全入口；
  普通态鼠标滚轮锚定缩放与三态钮也在此；prepareExit 只保留已 ready 预览填收尾洞
src/canvas/drawing.js: 纯快照内核——事务闭包/合并(槽位保序)/自动沉层判定/命中检测双模(描边带/热区/旋转逆变换)/
  双平面分流/槽位签名/字体签名/帧真相步进/相机与 IME 状态机/几何变换（翻译/删除/沉浮）——全部 node:test 可证伪
src/canvas/InkWorldLayer.jsx: 常驻 committed ink compositor——按 below 分流固定 48 槽、签名复用、只导 dirty 组、
  字体胶囊原子交接、exportScale=1、失败无限退避自愈(40ms→2s)+页面可见即重试、旧帧全程可见、
  layout effect 回报 rendered world（父层的显形/撤桥收尾都以此为凭）
src/canvas/MiniMapInk.jsx: 小地图墨迹层——镜像 minimap svg viewBox，区域底板/批注投进缩略图，纯展示穿透
src/canvas/container-carry.js: 承载纯规划与 DOM 桥——planBatchCarry(before/after 容器差+锚定)、
  createInkDragBridge(根变量拖动桥)/createBatchCarryBridge(整理逐锚桥)、SVG 锚标 marker 安装
src/canvas/connections.js: 落空连线与连接点命中区纯内核，尺寸可由 node:test 证伪
src/canvas/gestures.js: 导航手势纯内核——wheel/缩放键/Safari gesture 路由、设备判定(150ms 连续性)、
  锚定缩放/平移数学、幂等 pointer 监听资源、WHEEL_MODES 三态文案
src/canvas/layout.js: 纯布局内核——production buildGraph、手工锚点优先打包、增量补位、容器增长避让、
  tidyLayoutEntries 整理规划、容器缩放子项快照，node:test 合成数据证伪
src/canvas/menus.jsx: 七套右键菜单 + 三个删除流程 + 交接三件套入口——菜单、节点按钮、详情面板共用同一条河
src/canvas/DrawLayer.jsx: 仅编辑态挂载的 Excalidraw（React.lazy）——水合握手后每次稳定 change 上报父层（连续合并源头）、
  freezeDraft/alignViewport 控制器、大底板落笔手势识别、选绘图空点 onExitToCanvas、IME 上报；
  绝不直接持久化；字体本地化经 scripts/prepare-assets.mjs + EXCALIDRAW_ASSET_PATH
  ⚠️ 铁律: 画布级按钮必须做 React Flow 的兄弟节点(z:7)——RF 根自成层叠上下文
src/canvas/BoardNode.jsx: 用户画板（一等容器），BOARD_COLORS 五色，仅标题栏搬家，InlineEdit 改名/色盘/确认删除
src/canvas/DistrictNode.jsx: 街区真容器，与画板同皮肤，NodeResizer 拉角，缩放连同成员补偿坐标持久化
src/canvas/NoteNode.jsx: 四色贴纸便签，新生落地即编辑态，删除过确认(有字才打断)，NodeResizer + nodrag 文字区
src/canvas/WorkspaceNode.jsx: 工作区容器节点(memo)，工具占比条，worktree 红描边，折叠入口
src/canvas/SessionNode.jsx: 会话卡片(memo)，工具色脊柱 + 人话标题 + 状态灯/自动化角标
src/panels/ContextFrame.jsx: 画布终端窗——拉线落空/右键就地弹出：白岛壳+深色终端体（Tokyo Night）、
  标题栏可拖、打开停最新、上滑倒序翻页(/api/context-page)至"── 会话开始 ──"、滚动无跳补偿、
  content-visibility 原生虚拟化(万行 60fps)、回到最新浮钮、一键续开/详情/复制
src/panels/TopBar.jsx: 右上动作岛：有新活动举旗/整理/批量命名(进度轮询)/重扫/同步状态点
src/panels/Sidebar.jsx: 左侧导航岛，宽度可拖、可收回，单击定位、双击改名
src/panels/DetailPanel.jsx: 右侧详情岛——标题(就地改名)→一键续开→CONTEXT 摘要+digest→STOP 停止点→
  HANDOFF 接力(内置轻档生成 + 交接三件套 skill 终端出口)→RUNS 实例→DETAIL 元信息→删除收底

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

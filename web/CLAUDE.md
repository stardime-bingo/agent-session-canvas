# web/
> L2 | 父级: ../CLAUDE.md

React Flow 画布前端。**岛屿架构（v15）：画布即世界满屏铺底，一切 UI 都是漂浮岛（.island 同族皮肤）**——
左=导航岛(品牌/搜索/过滤/清单)、顶中=常驻画布工具岛(选择/画笔/形状/箭头/文字)、右上=动作岛、右=详情岛。
Dify 浅色基因：Dify 蓝 #155eef 锚点，Claude 橙 / Codex 青绿作工具身份色。

**v19 自研墨迹（2026-07-18）**：第三方绘图库整体拆除，绘画=ink 三件套直写场景文档，单表征单相机。
**v18 SceneStore 合同（同日）**：数据单向流 = graph 地形 + 场景文档 doc → 过滤管道 → 画布/面板；
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
  画布终端框(ContextFrame)开合 + pagehide keepalive/本地恢复双保险 + 空态指路牌
src/scene-store.js: 场景真相源——createSceneStore：同步 mutate/订阅/undo/redo(coalesce, 容量100)、稳定 sync status 快照、
  防抖 300ms 后台冲刷（files delta 先行、失败 1s→15s 无限退避、在飞期追加自动追赶）、adoptRemote LWW、
  pagehide flushNow keepalive（普通请求在飞时并发最新 clientSeq，服务端拒绝旧请求倒灌）
src/scene-recovery.js: pagehide 大载荷恢复边界——localStorage 同步保存不含图片正文的最终场景，IndexedDB 暂存未确认图片；
  仅在记录比服务端 canvas mtime 更新时回放，正常后台冲刷成功后清理，不进入日常渲染主权
src/api.js: 数据访问唯一通道——graph/session/contextPage/AI/launch + putScene 场景快照/putDrawingFiles 资产（均可 pagehide keepalive）+ WRITER_ID + subscribeEvents
src/util.js: 展示工具箱——relTime/shortPath/fmtSize/classifyDigestLine + handoffSkillPrompt(交接三件套自包含提示词) + TOOL_META/STATUS_META
src/ui.jsx: UI 原子库——Icon 单色 SVG 集、toast polite status（动作按钮可键盘触发）/confirmPop() 单例 + <UIHost/>、<InlineEdit/> 就地改名
src/theme.css: 视觉唯一真相源(Dify tokens)；节点皮肤类化 + toast/confirm/空态/边tooltip/drop-target 样式；
  tool-island 三组岛、cold/retrying/stale 帧状态 chip、over-drawing 悬停提示、ink-carry-anchor 承载桥位移——全部合成器动画
src/canvas/FlowCanvas.jsx: 画布引擎总装（≤800 行）——统一容器模型、归属律 layout.d>路径推断、容器弹性生长、
  边半受控(手动边可选可删系统边只观察)、onBeforeDelete 删除治理、折叠展开、就地改名信号、视口 localStorage 记忆、
  容器承载=乐观拖动+DOM 桥跟随+松手一次 mutate+帧追上撤桥（Escape 取消弹回）、applyArrange 同步规划一次 mutate、
  普通模式绘图命中（pane/一切节点同一条河、HIT_BLOCK 功能件排除、节点上只认浮层/pane 先浮后沉、
  待选态封闭形状内部热区）、右键沉浮/删除（可 undo）、落空连线选择菜单、连接点缩放感知、
  世界装配 doc.drawing/drawingFiles 交 InkLayer、4518 只读动作探针 seam；352 节点夹具仍挂真实 FlowCanvas 并由浏览器 held pointer 取 trace，匿名 hero 也只做 production FlowCanvas 的数据与构图层
src/canvas/ink.js: 自研墨迹模型纯函数——freedraw 中点贝塞尔路径/箭头端头/形状路径/元素工厂/拖画更新(反向拖归一化+亚像素节流)/收笔定稿判废/文字度量/样式常量，node:test 证伪
src/canvas/ink-selection.js: 选择纯内核——绑定闭包/框选/批量平移删除/八向缩放/旋转/复制 id 重映射，node:test 直接证伪
src/canvas/image-import.js: 图片导入边界——同步占位、后台 FileReader/解码/SHA-256 内容 id、有界等比尺寸；迟到读取不能复活已 undo 元素
src/canvas/InkLayer.jsx: 墨迹渲染层——元素直出 SVG（沉/浮两平面 + 多选框/八手柄/旋转柄），ViewportPortal 共用唯一 RF 相机，每元素带 data-ink-element-id 供承载桥；没有导出没有帧
src/canvas/InkTools.jsx: 墨迹交互层 useInkTools——拖画/文字击键/橡皮笔迹 coalesce mutate；框选/Shift 多选/批量移动缩放旋转删除改样式、ClipboardEvent 复制粘贴、Alt 拖、图片粘贴/拖入、V/P/R/O/A/T/E；armed 滚轮直改 RF 相机、空格让路原生平移
src/canvas/drawing.js: 墨迹纯几何——命中检测双模(描边带/热区/旋转逆变换/折线段/后画者优先)/精确包围盒/平移删除沉浮不可变变换/大实心底板判定/功能件排除清单，node:test 证伪
src/canvas/MiniMapInk.jsx: 小地图墨迹层——镜像 minimap svg viewBox，区域底板/批注投进缩略图，纯展示穿透
src/canvas/container-carry.js: 承载纯规划与 DOM 桥——planBatchCarry(before/after 容器差+锚定)、
  createInkDragBridge(根变量拖动桥)/createBatchCarryBridge(整理逆向 FLIP 桥)、SVG 锚标 marker 安装
src/canvas/connections.js: 落空连线与连接点命中区纯内核，尺寸可由 node:test 证伪
src/canvas/gestures.js: 导航手势纯内核——wheel 设备判定(150ms 连续性)、锚定缩放/平移数学、WHEEL_MODES 三态文案
src/canvas/layout.js: 纯布局内核——production buildGraph、手工锚点优先打包、增量补位、容器增长避让、
  tidyLayoutEntries 整理规划、容器缩放子项快照，node:test 合成数据证伪
src/canvas/menus.jsx: 七套右键菜单 + 三个删除流程 + 交接三件套入口——菜单、节点按钮、详情面板共用同一条河
src/canvas/BoardNode.jsx: 用户画板（一等容器），BOARD_COLORS 五色，仅标题栏搬家，InlineEdit 改名/色盘/确认删除
src/canvas/DistrictNode.jsx: 街区真容器，与画板同皮肤，NodeResizer 拉角，缩放连同成员补偿坐标持久化
src/canvas/NoteNode.jsx: 四色贴纸便签，新生落地即编辑态，删除过确认(有字才打断)，NodeResizer + nodrag 文字区
src/canvas/WorkspaceNode.jsx: 工作区容器节点(memo)，工具占比条，worktree 红描边，折叠入口
src/canvas/SessionNode.jsx: 会话卡片(memo)，工具色脊柱 + 人话标题 + 状态灯/自动化角标
src/panels/ContextFrame.jsx: 画布终端窗——拉线落空/右键就地弹出：白岛壳+深色终端体（Tokyo Night），加载失败自动退避重连；
  标题栏可拖、打开停最新、上滑倒序翻页(/api/context-page)至"── 会话开始 ──"、滚动无跳补偿、
  content-visibility 原生虚拟化(万行 60fps)、回到最新浮钮、一键续开/详情/复制
src/panels/TopBar.jsx: 右上动作岛：saved/dirty/saving/error 静默同步点/有新活动举旗/整理/批量命名(进度轮询)/重扫
src/panels/Sidebar.jsx: 左侧导航岛，宽度可拖、可收回，单击定位、双击改名
src/panels/DetailPanel.jsx: 右侧详情岛（加载失败自动退避重连）——标题(就地改名)→一键续开→CONTEXT 摘要+digest→STOP 停止点→
  HANDOFF 接力(内置轻档生成 + 交接三件套 skill 终端出口 + Claude/Codex 显式双接班入口)→RUNS 实例→DETAIL 元信息→删除收底
src/panels/HandoffLaunchChoices.jsx: 接力双工具入口——Claude Code/Codex 并列且无默认项；同一份接力文本只切换 launch.tool

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

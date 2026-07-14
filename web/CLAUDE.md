# web/
> L2 | 父级: ../CLAUDE.md

React Flow 画布前端。**岛屿架构（v15）：画布即世界满屏铺底，一切 UI 都是漂浮岛（.island 同族皮肤）**——
左=导航岛(品牌/搜索/过滤/清单)、顶中=常驻画布工具岛(选绘图/画笔激活后 Excalidraw 工具栏进驻上方)、右上=动作岛、右=详情岛。
Dify 浅色基因：Dify 蓝 #155eef 锚点，Claude 橙 / Codex 青绿作工具身份色。数据单向流：graph → 过滤管道 → 画布/面板。
丝滑四律：节点状态交还 React Flow、全量渲染不做视口裁剪(平移=纯 GPU 变换,裁剪的挂载churn才是卡顿源)、
动画只走合成器且平移中暂停(.canvas-moving)、绘图层单一真相直喂：每帧 rAF 合并推 Excalidraw scroll——
双表征(纹理+transform 桥)即残影之源，已废。
画布手势遵循成熟设计工具：空白左拖=框选，空格+左拖/中键=平移，触控板双指=平移、捏合=缩放，鼠标滚轮=光标锚定缩放
（gestures.js 逐事件判定设备，Ctrl/Meta/Shift 交还 RF 原生，缩放条第四钮三态兜底）；街区/画板仅标题栏可整块搬家，空白容器面不再是巨型拖拽区。
对象拖动语义：会话卡固定 → 工作区在街区容器内自由整理(碰一个快照全街区,拖动中目标容器高亮，只改看板归属不动本地文件) → 标题栏明确搬动街区/画板。
增量布局铁律：手工位置是优先锚点但不是重叠许可；工作区新增会话变高、补入新工作区、街区弹性增长时，
后方成员/容器必须确定性顺延避让，且只在渲染态消碰撞、不暗写 layout.json。

**交互五律（v16 审计波立法）**：
① 每一次点击必有可感知回应——选中态/菜单/提示三选一，全部节点与边可选中或可解释；
② 原生 alert/confirm/prompt 零容忍——改名走 InlineEdit 就地编辑，确认走 confirmPop 自绘弹层，回执走 toast；
③ 删除主权律——Backspace/Delete 只对便签/画板/手动边生效（会话/工作区/街区 deletable:false），
   写了字的便签与画板过确认，画板不走 RF 内部删除（级联子节点会悬空，由数据流重建移除）；
④ 藏起来必须给入口——工作区折叠有"展开其余 N 条"，搜索时自动全量直显，digest 有折叠摘录；
⑤ 不可逆动作必过确认——删会话(活跃门禁二次确认)/删画板/删有字便签；整理已改为保留 layout.d 人工归属的可逆几何重排，toast 按钮或 Cmd/Ctrl+Z 可撤销。

成员清单
index.html: 入口壳
src/main.jsx: 挂载点，只挂载不做逻辑
src/App.jsx: 总装线，全局状态 + 过滤管道(工具/状态/时间裁剪到会话粒度/搜索) + SSE 举旗 + 画板/便签/落空连线动作分发 +
  画布终端框(ContextFrame)开合 + drawingPersisted 本地回写(绘图层直连落盘后的状态同步) + 空态指路牌(筛空给"清除筛选"出口) +
  保留人工归属且可撤销的整理流；绘图属性岛按导航宽度动态让位，绘图激活时全局动作岛不退场
src/api.js: 数据访问唯一通道，组件不直接碰 fetch；layoutBatch 支持合并/原子替换，绘图图片/落空连线/上下文倒序分页(contextPage)走专线
src/util.js: 展示工具箱，relTime/shortPath/fmtSize/classifyDigestLine(digest 行→角色样式键，详情面板与终端框共用) + TOOL_META/STATUS_META 文案常量
src/ui.jsx: UI 原子库——Icon 单色 SVG 图标集(全站去 emoji)、toast(可选动作按钮)/confirmPop() 单例 + <UIHost/> 宿主、
  <InlineEdit/> 就地改名(editSignal nonce 外触 + 双击内触，Enter/失焦提交 Esc 取消)
src/theme.css: 视觉唯一真相源(Dify tokens)，全部 CSS 变量；节点皮肤类化(session-card/ws-card/container-face/note-face
  + .sel 选中态 + hover 态)、toast/confirm/inline-edit/空态/边tooltip/drop-target/connecting 样式；连接点使用透明命中层+独立视觉点，绝不覆盖 RF 定位 transform；禁用 box-shadow 动画；
  tool-island 三组岛(绘图激活滑移让位+图标微胀缩+激活呼吸环)、over-drawing 悬停提示 chip、菜单图标染蓝/渐隐分隔线、缩放条与迷你地图悬停染蓝——全部合成器动画
src/canvas/FlowCanvas.jsx: 画布引擎，统一容器模型（自动街区+用户画板同构）：归属律 layout.d 手动指定>路径推断，
  容器弹性生长包住成员；边半受控(useEdgesState,手动边可选可删系统边只可观察)；onBeforeDelete 删除治理；
  折叠展开(搜索时全量直显)；就地改名信号；边悬浮说明牌+点击解释；视口 localStorage 记忆；
  拖动投放目标高亮(DOM 类直改零重渲染)；节点重建用 useLayoutEffect 在绘制前接管并保留选中态，消除跨容器闪帧；
  Figma 式框选/平移/触控板手势与容器标题栏 dragHandle；滚轮双模 capture 监听(鼠标滚轮=缩放接管,其余放行,缩放条第四钮切三态)；
  容器缩放持久化子项补偿坐标；普通模式绘图命中走 pane/一切节点同一条河——含会话卡/工作区（点击描边带进选绘图并选中、右键选中/沉浮/删除、
  悬停指针光标+提示 chip，HIT_BLOCK 功能件排除清单两路共用；平面感知：节点上只认浮层、pane 先浮后沉；
  进绘图先清 RF 选中防 Delete 双雷；空画布点选绘图给指路 toast；belowHost 门户 DOM 首位垫底 + exitToCanvas 空点放行转交点击）；
  只认拖线(connectOnClick=false)，在 pane/容器面/边等画布空落点弹选择——会话卡首选打开上下文终端框，其余便签/画板原子落盘；
  连接点命中区按缩放同步：工作视图 28px、全景至少 12px，靠近节点扩到 28px，视觉圆点与命中层分离且圆心不跳；
  “选绘图/画笔”显式双入口与全局动作并列（再次点击或 Esc 退出）；connecting 类手动挂载；纯展示图例点击穿透不遮挡节点入口
src/canvas/connections.js: 落空连线与连接点命中区纯内核；只排除已有有效终点和画布 UI，容器空白不再被 event.target 等值判断静默吞掉；尺寸可由 node:test 证伪
src/canvas/gestures.js: 滚轮手势纯内核——wheelDevice 设备判定(强弱信号+150ms 连续性)、zoomViewport 光标锚定缩放数学、
  WHEEL_MODES 三态文案；FlowCanvas 只在"鼠标滚轮"一种事件上接管，其余交还 RF 原生；可由 node:test 直接证伪
src/canvas/layout.js: FlowCanvas 的纯布局内核，不读写磁盘；手工锚点优先的工作区打包、增量成员补位、容器增长避让，
  自动整理只提取 layout.d 归属并重置几何；提供容器缩放后直属子项快照，保证重建不跳，可由 node:test 用合成数据直接证伪
src/canvas/drawing.js: 绘图元素/图片文件的纯快照内核 + hitDrawingElement 命中检测（命中区严格贴墨迹：空心矩形/椭圆/菱形只认描边带、
  线/箭头/手绘按点到折线段距离、旋转元素逆变换跟着视觉走、实心全域、墓碑/锁定跳过、后画者优先）+
  双平面分流 splitDrawingPlanes(customData.below) + 精确包围盒 drawingBounds(旋转四角/折线 points 实算)，
  只保留仍被 image 元素引用的 BinaryFiles，全部可由 node:test 直接证伪
src/canvas/menus.jsx: 七套右键菜单构建器(session/workspace/district/board/note/pane/edge) +
  三个删除流程(deleteSessionFlow 含活跃门禁强删/deleteBoardFlow/deleteNoteFlow)——菜单、节点按钮、详情面板共用同一条河
src/canvas/BoardNode.jsx: 用户自建画板（一等容器），导出 BOARD_COLORS 五色表，仅标题栏可搬家，可选中可连线，
  InlineEdit 改名、色盘换色、删除走确认流；缩放松手由引擎连同成员补偿坐标一起持久化
src/canvas/DistrictNode.jsx: 街区真容器，与画板同皮肤(container-face + CSS 变量注色)，仅标题栏可搬家，可选中可连线，
  NodeResizer 拉角调尺寸(下限=内容包络)，缩放松手连同成员补偿坐标一起持久化
src/canvas/NoteNode.jsx: 用户便签，四色贴纸可选中，新生便签(5s内诞生未写字)落地即入编辑态，
  删除走确认流(有字才打断)，NodeResizer 调尺寸 + 防抖落盘 + nodrag 文字区
src/canvas/DrawLayer.jsx: Excalidraw 双平面绘图层(React.lazy 拆包,无笔迹不挂载)。沉层(customData.below)经 belowHost 门户
  静态导出垫在 React Flow 之下(EXPORT_CAP 4096 降采样帽,pushViewport 每帧同步定位,水合首声 onChange 补分流)；
  激活全量合流进活实例、退出分流；setElementPlane 沉浮切换；选绘图空点(未命中笔迹/无选中/非框选)经 onExitToCanvas 放行回看板。
  坐标契约 scroll=viewport/zoom，
  onScrollChange 实时回传+回声守卫双向同步；未激活时 UI 全隐；激活后保留原生选择与描边/背景/透明度/图层属性岛；
  ref 暴露 getElements/selectElement/deleteElement 供普通模式删除通路（删除即时落盘不等防抖、连带删 containerId 绑定标签、
  返回 Promise 供回执跟真实结果走）+ persist 成功后经 onPersisted 回写 App 状态（首笔退出不再消失）+ pagehide 冲刷关防抖丢失窗口；
  属性岛按导航实时宽度让位而非藏在其后；图片开启并把 BinaryFiles 独立持久化/裁剪；
  zh-CN、clearCanvas 关闸、卸载冲刷。字体本地化: build 前由 scripts/prepare-assets.mjs 从 Excalidraw 包同步到
  web/public/fonts（不入 Git）+ EXCALIDRAW_ASSET_PATH
  ⚠️ 铁律: 画布级按钮必须做 React Flow 的兄弟节点(z:7)——RF 根自成层叠上下文，Panel 内按钮会被激活的画笔层截住
src/canvas/WorkspaceNode.jsx: 工作区容器节点(memo)，工具占比条，worktree 红描边(.wt)，可选中，
  InlineEdit 改名 + 底部"展开其余 N 条/收起"折叠入口
src/canvas/SessionNode.jsx: 会话卡片节点(memo)，工具色脊柱 + 人话标题两行(InlineEdit 双击改名) + 状态灯/自动化角标，
  hover 提边选中蓝锚
src/panels/ContextFrame.jsx: 画布终端窗——拉线落空/右键"打开会话上下文"就地弹出：白岛壳+深色终端体、标题栏可拖(Pointer Capture)、
  Esc capture 关闭不连坐；像真终端：打开停在最新输出、上滑倒序翻页(/api/context-page)直至"── 会话开始 ──"、
  翻页滚动无跳补偿(scrollHeight 差值 layout 前回写)、空页自动续跳(8 页上限)、olderRef 防滚动风暴重入、
  页级 memo + content-visibility 原生虚拟化(万行 60fps)、回到最新浮钮、已载进度徽章；
  旧 daemon 自动回退 /api/session 节选并挂【节选】提示、一键续开/详情/复制；
  Ghostty 级皮肤：Tokyo Night 调色板 CSS 变量一处定调（深底/暗题头底栏融为一体）、用户行绿 ❯ 提示符、
  工具行青名暗参语法高亮(toolLine)、报错珊瑚红、底部呼吸块光标(canvas-moving 屏息)
src/panels/TopBar.jsx: 右上动作岛：有新活动举旗(服务端签名 diff,纯写盘不举)/可撤销整理/批量命名(进度轮询)/重扫
src/panels/Sidebar.jsx: 左侧导航岛，宽度可拖、可收回，单击定位、双击 InlineEdit 改名，清单空态一句实话
src/panels/DetailPanel.jsx: 右侧详情岛。信息层次铁律：标题(就地改名+铅笔)→一键续开(黄金位)→
  CONTEXT 聊了什么(摘要+digest 对话摘录渲染器,用户蓝/助手灰/工具淡/报错红,有摘要时摘录折叠)→
  STOP 最后停在哪里(独立尾部摘录,默认展示最后14行,不受开场 digest 前向截断)→
  HANDOFF 接力→RUNS 运行实例清单(automation)→DETAIL 元信息(路径开 Finder/ID 点击复制)→删除收底；
  错误态可重试；全部动作 toast 回执

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

# web/
> L2 | 父级: ../CLAUDE.md

React Flow 画布前端。**岛屿架构（v15）：画布即世界满屏铺底，一切 UI 都是漂浮岛（.island 同族皮肤）**——
左=导航岛(品牌/搜索/过滤/清单)、顶中=常驻画布工具岛(选绘图/画笔激活后 Excalidraw 工具栏进驻上方)、右上=动作岛、右=详情岛。
Dify 浅色基因：Dify 蓝 #155eef 锚点，Claude 橙 / Codex 青绿作工具身份色。数据单向流：graph → 过滤管道 → 画布/面板。

**v17 根治进行中**：LE-008/009 已收口 rendered frame 与稳定局部槽；LE-010 已收口相机尾窗，LE-011R/LE-011B 已收口 direct/batch carry；LE-012 已收口本地 draft journal 与 BinaryFiles 安全事务。LE-013 正在收口自动沉底撤销、toast 可达性与静态 4518/build 闭包；LE-013/014 未通过前不得宣告根治。
4518 人工尾窗证伪由始终可见按钮在真实 selection 事务 live 后武装只读 rAF+timer 双时钟观察，只由 Computer Use 真实手工具拖动触发；fixture 不写相机/viewport、不派发输入，timer 只补捕 resuming 且绝不充当 shield 帧样本，捕获后只调 production exitDrawing 并延迟 dirty closing export 取样。每轮以唯一 run token/scenario、call 起点和精确 production closing revision 三重隔离，旧观察器/timeout/fail 不覆盖新 UI；LE-010 证据恰好三轮 fresh hard refresh，每轮必须保留严格九步 action、五阶段 production snapshot 和 Shift+1/2/3 的 before/after/target 有限数样本。
LE-010 证据来源逐字锁定 4518 interaction：每轮由 Computer Use 采集 address/selection/tail 三张 PNG，九个固定 artifact ID 分别被 hardRefresh/openDrawingSelection/readDiagnostics 引用；raw/截图必须封闭在当前 candidate evidence 目录且非软链，focused gate 复算字节/hash、解析 IHDR/IEND/尺寸，并把 artifact 元数据传递进 manifest 已哈希的 behavior log。Judge 仍需目视九图，4517、伪 source/proof、旧 candidate、越界或复用截图一律失败。
丝滑四律：节点状态交还 React Flow、全量渲染不做视口裁剪(平移=纯 GPU 变换,裁剪的挂载churn才是卡顿源)、
动画只走合成器且平移中暂停(.canvas-moving)、已提交绘图与节点同在 React Flow viewport 内、共用唯一 transform——
视口手势不再驱动 Excalidraw 或绘图重导出；编辑只 hole-punch 目标事务 originalIds，静态/live 不重复同一元素。
画布手势遵循成熟设计工具：空白左拖=框选，空格+左拖/中键=平移，触控板双指=平移、捏合=缩放，鼠标滚轮=光标锚定缩放
（gestures.js 逐事件判定设备；普通态 Ctrl/Meta/Shift 交还 RF 原生，编辑态统一产出 RF viewport，缩放条第四钮三态兜底）；街区/画板仅标题栏可整块搬家，空白容器面不再是巨型拖拽区。
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
  画布终端框(ContextFrame)开合 + drawingCommit 按上一成功快照计算 files delta，以 sceneToken CAS/receipt status 提交并安装完整本地 files 快照（保留 drawingPersisted 旧回调兼容）+ 空态指路牌(筛空给"清除筛选"出口) +
  保留人工归属且可撤销的整理流（每次成功整理覆盖旧票据、只撤最近一步；prepareGeometry 先提交退出 active 绘图；production buildGraph 同步规划 before/after 与 rendered-world 互斥 anchors，整理/撤销各自只发一次 batch carry；同一 flushSync commit 安装权威 layout/drawing 和多 delta bridge，精确目标帧进 DOM 才撤桥）；
  绘图属性岛按导航宽度动态让位，绘图激活时全局动作岛不退场
src/api.js: 数据访问唯一通道，组件不直接碰 fetch；layoutBatch 支持普通几何合并，containerBatchCarry 专管整理/撤销；drawing-set/status 只在双路径都不确定时报告 AUTHORITY_UNKNOWN，明确 unknown 保持可重试；落空连线/上下文倒序分页(contextPage)走专线
src/util.js: 展示工具箱，relTime/shortPath/fmtSize/classifyDigestLine(digest 行→角色样式键，详情面板与终端框共用) + TOOL_META/STATUS_META 文案常量
src/ui.jsx: UI 原子库——Icon 单色 SVG 图标集(全站去 emoji)、toast polite status（动作按钮可键盘触发，hover/focus 暂停关闭，动作保留 30s）/confirmPop() 单例 + <UIHost/> 宿主、
  <InlineEdit/> 就地改名(editSignal nonce 外触 + 双击内触，Enter/失焦提交 Esc 取消)
src/theme.css: 视觉唯一真相源(Dify tokens)，全部 CSS 变量；节点皮肤类化(session-card/ws-card/container-face/note-face
  + .sel 选中态 + hover 态)、toast/confirm/inline-edit/空态/边tooltip/drop-target/connecting 样式；连接点使用透明命中层+独立视觉点，绝不覆盖 RF 定位 transform；禁用 box-shadow 动画；
  tool-island 三组岛(绘图激活滑移让位+图标微胀缩+激活呼吸环)、drawing-opening 透明几何拦截层、cold/retrying/stale 帧状态 chip、over-drawing 悬停提示 chip、菜单图标染蓝/渐隐分隔线、缩放条与迷你地图悬停染蓝——全部合成器动画
src/canvas/FlowCanvas.jsx: 画布引擎，统一容器模型（自动街区+用户画板同构）：归属律 layout.d 手动指定>路径推断，
  容器弹性生长包住成员；边半受控(useEdgesState,手动边可选可删系统边只可观察)；onBeforeDelete 删除治理；
  折叠展开(搜索时全量直显)；就地改名信号；边悬浮说明牌+点击解释；视口 localStorage 记忆；
  拖动投放目标高亮(DOM 类直改零重渲染)；direct carry 不用 pointer-start 推导 bridge，RF node.position 进 DOM 后才在 useLayoutEffect 同步墨迹并从同一点 DROP；节点重建也由 useLayoutEffect 在绘制前接管并保留选中态，消除跨容器闪帧；
  Figma 式框选/平移/触控板手势与容器标题栏 dragHandle；滚轮双模 capture 监听(鼠标滚轮=缩放接管,其余放行,缩放条第四钮切三态)；
  容器缩放持久化子项补偿坐标；普通模式绘图命中走 pane/一切节点同一条河——含会话卡/工作区（点击描边带进选绘图并选中、右键选中/沉浮/删除、
  悬停指针光标+提示 chip，点击/右键/悬停共用唯一 HIT_BLOCK 功能件排除清单（含 nodrag 与 React Flow 连接点）；平面感知：节点上只认浮层、pane 先浮后沉；
  普通 props 只在真正激活为世界时分配单调 revision，override 期 pending input 不预分配；FlowCanvas render 只纯推导 world，persisted/revision/requested 三类帧主权只在 layout effect 随 commit 发布，abandoned speculative render 不改当前代际；InkWorld exportScale 固定 1，Retina 下 SVG DOM 尺寸仍与 RF 世界几何同尺；DOM-ready 后才安装 rendered world，普通命中、悬停、右键与 MiniMap 共用其 visible elements；cold 无命中并立即提示，warm 失败保留 stale 帧并最多三次重试；4518 的 frameTestProbeRef 只在 layout effect 暴露 snapshot 与 production openDrawing/exitDrawing，故障只从 Ink exporter seam 注入，禁止手写 callbacks/handoff refs；后置 Suspense sibling 证伪 B 弃置期 A 仍能完成真实 opening/closing；
  选绘图无目标只武装普通平面；待选态矩形/椭圆/菱形内部扩大为选择热区，线/箭头/手绘仍贴墨迹，命中浮/沉静态元素后才排空队列并创建目标递归关系闭包事务；形状外空点退出 armed 且原点击继续给节点/画布，新绘图从空事务开始；
  进事务先清 RF 选中防 Delete 双雷并封住普通提交与节点几何，局部 draft 水合后先隐藏，InkWorld hole 帧 DOM ready 才同帧显现；geometryPending 优先完成，active 整理先 await 全量 merge+exit；
  尚未显现、不可交互的 opening draft 退出时在 flush/落盘/closing 前纯取消，清空 handoff/override/事务/opening resolver 并恢复 committed 世界；每次 opening 用唯一对象身份隔离，whenIdle then/catch、DrawLayer ready 与 InkWorld 帧回调都先验本代 request，旧代迟到回调完全静默。IndexedDB 单 active draft 仅在 sceneToken+事务闭包指纹精确匹配时恢复为局部 editSeed，并复用其 requestId 保持条件清理所有权；冲突继续拒绝覆盖且正文原样保留，只提供无正文元数据查看、本机 JSON 下载与 requestId+epoch 精确放弃（confirmPop 二次确认），放弃后入口立即恢复；已显现事务才由串行队列把 draft 合并进最后成功的全量 elements/files；首次 new 事务的 primary/左键手势只看本次新增 ID，实心 rectangle/ellipse/diamond 达宽400/高300/面积120000后在 pointerup 后等最终 change 稳定两帧，只 signal 一次既有 exitDrawing。唯一提交链再把宿主与 containerId 绑定文字自动沉层；selection/透明小形状/旧元素编辑/IME/已 rebase 事务不自动退场，完整帧交接成功后给可撤销 toast。落盘成功立即把 prepared draft IDs 并入事务所有权并 rebase merged 基线；closing 锁住新输入并保持 live 填洞，完整 merged SVG DOM ready 后同帧卸载并按 requestId 条件清 journal；若 closing 失败则以回执 sceneToken 和 advanced transaction 重新 begin，继续编辑仍可崩溃恢复。屏幕 worldOverride、提交队列和持久化 props 只在 idle 且 props 同引用追上 override 或当前队列快照时同步撤桥，未知迟到 props 不得倒灌；撤销持久化后稳定排空等待期间新增的 tail，只有排空仍为 restored 且换屏瞬间无 pending/编辑事务才装新 revision，后续成功跳过旧上屏、后续失败仍恢复。导出失败仍以 rebased ownership 保留洞/编辑器并明确回执“已保存但画面交接失败”，submit reject 才报“未落盘”。普通态删除/沉浮/承载基于上一成功快照串行提交，exitToCanvas 落盘后转交点击）；
  编辑态导航在 root capture 首事件即停 Excalidraw；freezeDraft 对 IME 组字拒绝、对普通文字 blur 后等 onChange 稳定，再用第二 InkWorldLayer 直接导出局部静态预览。wheel 三路路由为外部功能件 pass、Excal textarea/Island block（只 stopPropagation）、绘图面 camera（prevent+stop）；FlowCanvas 单一持有 Meta/Ctrl +/-/0，以视口中心锚定只产出 RF viewport，焦点留在缩放岛/body 也不放回 Excal；Safari gesture 亦在 capture 封住 Excal 旁路。window pointer 监听封装为幂等资源，真实 attach/cleanup 分别只读计数且 finish/reset/exit/unmount 均清零。预览 DOM ready 后隐 live、同 commit 挂 z:6 透明输入盾并应用累积 RF viewport；suspended/resuming 期导航逐事件只写 RF，180ms 尾部经唯一入口成功 alignViewport 一次后才进入 resuming 等双 rAF，opening 与 suspended 退出也走同一入口并只计真实成功；握手后同 commit 恢复 live/撤预览/撤盾。z:7 缩放岛的减/加/100%/全景同走该事务。新手势抢占迟到 resume，freezing 退出卸载未 ready preview，只保留 suspended/resuming 副本填 closing 洞，resuming 退出不重复 align；IME 同周期只 freeze/提示一次，compositionend 解锁；
  只认拖线(connectOnClick=false)，在 pane/容器面/边等画布空落点弹选择——会话卡首选打开上下文终端框，其余便签/画板原子落盘；
  连接点命中区按缩放同步：工作视图 28px、全景至少 12px，靠近节点扩到 28px，视觉圆点与命中层分离且圆心不跳；
  “选绘图/画笔”显式双入口与全局动作并列（再次点击或 Esc 退出）；connecting 类手动挂载；纯展示图例点击穿透不遮挡节点入口
src/canvas/connections.js: 落空连线与连接点命中区纯内核；只排除已有有效终点和画布 UI，容器空白不再被 event.target 等值判断静默吞掉；尺寸可由 node:test 证伪
src/canvas/gestures.js: 导航手势纯内核——drawingWheelRoute/drawingZoomKeyCommand/drawingGestureCapture 封住 wheel/缩放键/Safari gesture 旁路并只产出 RF command，keyboardViewport 以 root 中心锚定 +/-/100%；wheelDevice 设备判定(强弱信号+150ms 连续性)、panViewport 增量平移、zoomViewport/scaleViewport 锚定缩放、createPointerListenerResource 幂等监听资源、
  wheelViewport 统一编辑态触控板/鼠标/Shift/捏合数学与 WHEEL_MODES 三态文案；普通态仍只接管鼠标滚轮，可由 node:test 直接证伪
src/canvas/layout.js: FlowCanvas 的纯布局内核，不读写磁盘；production buildGraph、手工锚点优先的工作区打包、增量成员补位、容器增长避让，
  自动整理只提取 layout.d 归属并重置几何；同步 before/after 规划也调用同一 buildGraph，包含碰撞造成的 board 视觉位移；提供容器缩放后直属子项快照，保证重建不跳，可由 node:test 用合成数据直接证伪
src/canvas/container-carry.js: direct carry controller/marker bridge 与全局 scene mutation queue；另提供 batch arrange planner、多 delta bridge 和 commit→receipt/status 判定，unknown authority 在 request 前阻断已排队/新写且仅成功 authority graph reload 可解除
src/canvas/drawing.js: 绘图元素/图片文件的纯快照内核 + 目标容器/绑定/箭头端点/画框/分组递归闭包、selection/new 局部事务、整理单步墨迹撤销票据与唯一功能件命中排除表、isLargeFilledDrawingElement 共享阈值 + drawingAutoExitGestureStep 单手势稳定/防重纯状态机 + 首次 new 自动沉层、持久化后 ownership advance、visible committed hole 与保留非连续 original 全局槽位的全量 merge + 编辑器水合就绪握手、drawingCameraStep/drawingCameraExitPolicy 相机 token 与退出策略、drawingCameraPresentation 从可渲染 live/preview 表征推导输入盾、drawingCompositionStep IME 周期 + canvasGeometryAllowed/opening preparation + committed 过滤/删除/沉浮/平移不可变变换 + drawingFilesDelta 资产增量 + createDrawingCommitQueue 串行提交/本笔 receipt 与成功代际守卫撤销 + worldOverride/props/queue 三真相纯同步门（到队首才变换、失败不毒后续、
  whenIdle 递归追赶等待期间追加的 tail 并返回最后成功同快照、isIdleAt 同步复核 pending 与成功代际、pending 时拒绝 stale 外部快照倒灌）+ hitDrawingElement 双模命中检测（普通命中区严格贴墨迹：空心矩形/椭圆/菱形只认描边带；显式待选态封闭形状含内部、
  线/箭头/手绘按点到折线段距离、旋转元素逆变换跟着视觉走、实心全域、墓碑/锁定跳过、后画者优先）+
  双平面分流 splitDrawingPlanes(customData.below) + 不序列化大数据的 drawingPlaneSignature/drawingPlaneDirtyPlan（深克隆同视觉复用，几何/层级/Excal 版本/引用图片标量变更精准脏化）+ drawingPlaneGroups/drawingPlaneGroupPlan（每面先按完整 committed z-order 固定 48 元素槽，再槽内 hole；空槽 clear 且后续槽不漂移）+ drawingFontSignature/drawingFontWorkRoute（全帧按字体族+去重字符集签名）+ drawingPlaneWorkRoute/drawingPlaneSettledInFlight（ready 复用、同槽同签名在途 join、旧 Promise 不清新世代）+ 精确包围盒 drawingBounds(旋转四角/折线 points 实算)，
  只保留仍被 image 元素引用的 BinaryFiles，全部可由 node:test 直接证伪
src/canvas/drawing-draft-store.js: 浏览器 IndexedDB 单 active 草稿 journal + FlowCanvas 协调器；requestId+epoch 条件清理、seq 防抖串写、水合首 change 拦截、迟到 put 身份补偿删除、sceneToken+事务闭包+baseline 指纹精确恢复，merged 指纹识别已提交旧记录；冲突旁路只读 inspect 元数据、exportActiveDraft 深拷贝正文与 discard 精确身份删除，不自动覆盖/清除；closing 失败用 committed token+advanced transaction 原子 rebase；另提供只浮起票据 sunkIds 的自动沉底撤销代际协调；quota/不可用只提示一次且不阻断主提交
src/canvas/MiniMapInk.jsx: 小地图墨迹层——只读已 paint rendered world/revision，镜像 React Flow minimap 的 svg viewBox（MutationObserver 追踪，零重复投影数学），
  区域底板实心/批注描边投进缩略图，纯展示 pointer-events:none
src/canvas/InkWorldLayer.jsx: 常驻 committed ink compositor——按 below 分流完整世界并固定连续 z-order 槽，exportScale=1 保证 Retina DOM 视觉与世界命中同尺；excludedIds 只过滤槽内元素；按槽位复用 ready SVG、join 同签名在途 Promise，只导出 dirty 组，整组 hole 直接 clear 且不调用空数组 exporter；所有组 skipInliningFonts，整帧 visible text union 单独用公开 exportToSvg 抽出唯一 font capsule，字体与 groups 全部就绪后一次 commit，此前保留旧完整帧；
  同内容 revision 前进零导出但仍 ready，ref 落 DOM 后在 layout effect 回报实际 visible rendered world、平面兼容 metrics、groupCounts 与 font exported/joined/reused/cleared，让父层首 paint 前原子换帧；导出失败以 40/80ms 最多三次重试，迟到世代静默。通过 ViewportPortal 继承唯一相机，视口不触发导出，所有快照 pointer-events:none。300/800 真实 exportToSvg 由 tests/fixtures/canvas-acceptance 在隔离 4518 验收；interaction 合约必须具名 concurrent/revision/opening/closing/coldError/warmError/lateIsolation 全 true，console error/warning、page error 与 API resources 全零；focused node:test 会实际 Vite build fixture，并可用 LE008_COMPUTER_USE_EVIDENCE 把三轮原始 Computer Use 单行 JSON 与 candidate SHA 绑定进 behavior log；生产构建用 entries-aware group 隔离 subset worker 闭包并由 npm build 递归验边，浏览器 worker 运行仍以实机 console 为最终判准
src/canvas/menus.jsx: 七套右键菜单构建器(session/workspace/district/board/note/pane/edge) +
  三个删除流程(deleteSessionFlow 含活跃门禁强删/deleteBoardFlow/deleteNoteFlow)——菜单、节点按钮、详情面板共用同一条河
src/canvas/BoardNode.jsx: 用户自建画板（一等容器），导出 BOARD_COLORS 五色表，仅标题栏可搬家，可选中可连线，
  InlineEdit 改名、色盘换色、删除走确认流；缩放松手由引擎连同成员补偿坐标一起持久化
src/canvas/DistrictNode.jsx: 街区真容器，与画板同皮肤(container-face + CSS 变量注色)，仅标题栏可搬家，可选中可连线，
  NodeResizer 拉角调尺寸(下限=内容包络)，缩放松手连同成员补偿坐标一起持久化
src/canvas/NoteNode.jsx: 用户便签，四色贴纸可选中，新生便签(5s内诞生未写字)落地即入编辑态，
  删除走确认流(有字才打断)，NodeResizer 调尺寸 + 防抖落盘 + nodrag 文字区
src/canvas/DrawLayer.jsx: 仅目标事务挂载的 Excalidraw 局部 draft(React.lazy 拆包)；armed/普通态不挂实例。单握手 ref 等待 API 与首次 onChange 水合，只回传一次稳定 controller，
  首次水合的默认 selection 不回灌，只有 ready 前已就绪的后续 change 才上报工具；
  编辑器 `.Island` 功能岛在 pointerdown 即清空退场候选，真 canvas 空白仍可触发 onExitToCanvas；首次 new 事务记录 primary/左键 pointerId、token、工具、beforeIds 与 changeVersion；pointerup 后最多三帧取得两帧稳定快照，本次新增大实心区域才先封 token 再通知 FlowCanvas。pointercancel/新手势/工具切换/IME/隐藏/卸载作废，自动切回 selection 发生在 released 后不误杀；
  ref/onReady 共用该对象；坐标契约 scroll=viewport/zoom，保留原生选择与属性岛，快捷键所有权完全上收 FlowCanvas；controller 只暴露 opening/resume 同步 alignViewport、IME/文字稳定 freezeDraft、工具/选中/快照与 flush，composition start/end 同步上报 FlowCanvas，没有 onScrollChange 反馈或逐事件 updateScene，
  初始 elements/files 只接收目标闭包或空事务；首次 onChange 水合 ready 后才上报本地 journal；flush 只返回 draft、不碰 API 持久化，FlowCanvas 全量 merge 落盘且完整帧交接后才允许卸载；
  失败时保留编辑现场和 hole committed 帧，pagehide/visibility hidden 只请求父层 flush IndexedDB、不 fetch；选绘图空点经 onExitToCanvas 走同一事务门后放行
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

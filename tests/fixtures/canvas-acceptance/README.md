# 4518 自研墨迹验收夹具

只绑定 `127.0.0.1:4518`，使用确定性内存数据；不请求 4517、不读写 `data/`，也不接触 launchd。真实 4517 仍严禁坐标自动化；合成 keyboard/pointer/clipboard 只允许在本夹具内驱动 production `FlowCanvas`。

## 六种模式

- performance：真实 `ReactFlow + InkLayer` 直渲 300/800 元素，要求 DOM 数量完整、console/page error 为零，并守住 900ms/1600ms 挂载红线。
- interaction：真实 `FlowCanvas + SceneStore + UIHost` 全内存运行 26 项检查：冷渲、连发即时、DOM 同步、P/R/O/A/T/E 实画、笔迹/文字/选择环可见位置、真实鼠标文字焦点、顶栏快捷键帽、文字编辑/字号/变换、框选与 Shift 加选、批量样式/移动/缩放/旋转/删除、复制粘贴、Alt 拖、图片 paste/drop/变换、橡皮与删除 undo、Esc 收工具、后台冲刷、console clean。
- performance-352：确定性匿名数据生成 1 街区 + 12 工作区 + 335 会话 + 3 画板 + 1 便签，共 352 个真实 React Flow 节点，并补齐 171 个活跃状态点、22 条关系线与 3 个墨迹元素；浏览器先取空闲 trace，要求常驻动画及 `UpdateLayoutTree / PrePaint / Paint` 全为 0，再用 held pointer 依次拖动街区、工作区与便签，采集各自 rAF 帧间隔、Long Task 与原始 CDP Performance trace。
- hero：production `FlowCanvas + SceneStore + TopBar` 的专用匿名构图；展示会话卡、画板、便签、自研墨迹与真实同步点，不含验收 HUD，也不读取真实路径或资产。
- handoff-choice：production `HandoffLaunchChoices` 的匿名双入口；分别用键盘和指针选择 Claude Code/Codex，断言两家收到同一份接力提示词且页面加载时不会默认拉起任何一家。
- layout-quality：production `FlowCanvas + SceneStore + TopBar` 的匿名乱序地图；真实点击“智能整理”，直接读取 React Flow DOM 验证工作区活跃度行对齐、1–4 条平衡车道、画板压缩并参与排布、街区终点持久化、容器墨迹随行、便签不动及一键撤销；随后让已整理街区增长，确认后继与其墨迹同 delta 顺延且仍零碰撞，再真实拖动后继街区缩放手柄，验证投影先原子提交且墨迹不跳。基线与全量 DOM 读取在产品计时窗外，首帧只绑定目标节点 transform 提交，并采集同步耗时与 Long Task。

所有轮询使用 `setTimeout`，不依赖隐藏标签页会停摆的 `requestAnimationFrame`。输入先同步进入 SceneStore；验收观察者只等待 React commit 与后台冲刷，不把等待塞回产品交互路径。

## 运行

```bash
npm run acceptance:canvas
```

- `http://127.0.0.1:4518/?size=300`
- `http://127.0.0.1:4518/?size=800`
- `http://127.0.0.1:4518/?mode=interaction`
- `http://127.0.0.1:4518/?mode=performance-352`
- `http://127.0.0.1:4518/?mode=hero`
- `http://127.0.0.1:4518/?mode=handoff-choice`
- `http://127.0.0.1:4518/?mode=layout-quality`

机器探针统一为 `window.__CANVAS_ACCEPTANCE__`；interaction 可用可见按钮手动启动，也可加 `&autorun=1`。

另开终端运行自动门：

```bash
python3 tests/fixtures/canvas-acceptance/verify.py --suite canvas
# 或先以 npm run acceptance:prod 启动服务，再运行：
python3 tests/fixtures/canvas-acceptance/verify.py --suite prod
# 352 节点空闲与拖动性能报告、两份 gzip trace 写入被 Git 忽略的 output/acceptance：
python3 tests/fixtures/canvas-acceptance/verify.py --suite perf352

# 生成 README 匿名产品图，并输出机器可读诊断/泄漏报告
python3 tests/fixtures/canvas-acceptance/capture-hero.py
```

`--suite prod` 先以只读 graph/EventSource stub 启动真实 production 入口，再在 fresh context 运行 26 项墨迹全链（其中文字用 Playwright 真实鼠标验焦点）、接力双工具选择与智能整理；四段都要求 console error/warning、page error、失败请求、外联与 `/api` 资源为零。

`--suite perf352` 先要求 352 节点及上述真实拓扑完整，并在 1500ms 空闲窗内满足运行中动画、`UpdateLayoutTree`、`PrePaint`、`Paint` 全为 0；随后要求三个拖动目标都达到 ≥90 个真实 rAF 样本、≥100 个 pointer move、≥80 个不同位置、位移 ≥150px、帧间隔 p95 ≤20ms、最大 ≤50ms、慢帧比例 ≤5%、页面与 CDP Long Task 均为 0。报告记录浏览器版本、两份 trace 的 SHA-256、字节数与全部阈值。它测的是真实空闲成本与真实拖动，不拿 300/800 挂载耗时做代理。

隔离闸门：

```bash
curl -i http://127.0.0.1:4518/api/probe
```

唯一合格结果是 `403 Forbidden`。

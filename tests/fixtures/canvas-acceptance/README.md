# 4518 自研墨迹验收夹具

只绑定 `127.0.0.1:4518`，使用确定性内存数据；不请求 4517、不读写 `data/`，也不接触 launchd。真实 4517 仍严禁坐标自动化；合成 keyboard/pointer/clipboard 只允许在本夹具内驱动 production `FlowCanvas`。

## 两种模式

- performance：真实 `ReactFlow + InkLayer` 直渲 300/800 元素，要求 DOM 数量完整、console/page error 为零，并守住 900ms/1600ms 挂载红线。
- interaction：真实 `FlowCanvas + SceneStore + UIHost` 全内存运行十五链：冷渲、连发即时、DOM 同步、V/P/E 快捷键、框选多选、批量移动、缩放、旋转、复制粘贴、Alt 拖、图片粘贴、橡皮撤销、删除撤销、后台冲刷、console clean。
- performance-352：确定性匿名数据生成 1 街区 + 1 工作区 + 350 会话，挂载真实 production `FlowCanvas`；浏览器 held pointer 拖动街区标题栏，采集 rAF 帧间隔、Long Task 与原始 CDP Performance trace。
- hero：production `FlowCanvas + SceneStore + TopBar` 的专用匿名构图；展示会话卡、画板、便签、自研墨迹与真实同步点，不含验收 HUD，也不读取真实路径或资产。
- handoff-choice：production `HandoffLaunchChoices` 的匿名双入口；分别用键盘和指针选择 Claude Code/Codex，断言两家收到同一份接力提示词且页面加载时不会默认拉起任何一家。

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

机器探针统一为 `window.__CANVAS_ACCEPTANCE__`；interaction 可用可见按钮手动启动，也可加 `&autorun=1`。

另开终端运行自动门：

```bash
python3 tests/fixtures/canvas-acceptance/verify.py --suite canvas
# 或先以 npm run acceptance:prod 启动服务，再运行：
python3 tests/fixtures/canvas-acceptance/verify.py --suite prod
# 352 节点拖动性能报告与 gzip trace 写入被 Git 忽略的 output/acceptance：
python3 tests/fixtures/canvas-acceptance/verify.py --suite perf352

# 生成 README 匿名产品图，并输出机器可读诊断/泄漏报告
python3 tests/fixtures/canvas-acceptance/capture-hero.py
```

`--suite prod` 先以只读 graph/EventSource stub 启动真实 production 入口，再在 fresh context 运行十五链与接力双工具选择；三段都要求 console error/warning、page error、失败请求、外联与 `/api` 资源为零。

`--suite perf352` 要求 352 节点完整、≥90 个真实 rAF 样本、帧间隔 p95 ≤20ms、最大 ≤50ms、慢帧比例 ≤5%、页面与 CDP Long Task 均为 0；报告记录浏览器版本、trace SHA-256、字节数与全部阈值。它测的是拖动，不拿 300/800 挂载耗时做代理。

隔离闸门：

```bash
curl -i http://127.0.0.1:4518/api/probe
```

唯一合格结果是 `403 Forbidden`。

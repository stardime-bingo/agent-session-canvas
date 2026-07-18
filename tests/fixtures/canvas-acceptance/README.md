# 4518 自研墨迹验收夹具

只绑定 `127.0.0.1:4518`，使用确定性内存数据；不请求 4517、不读写 `data/`，也不接触 launchd。真实 4517 仍严禁坐标自动化；合成 keyboard/pointer/clipboard 只允许在本夹具内驱动 production `FlowCanvas`。

## 两种模式

- performance：真实 `ReactFlow + InkLayer` 直渲 300/800 元素，要求 DOM 数量完整、console/page error 为零，并守住 900ms/1600ms 挂载红线。
- interaction：真实 `FlowCanvas + SceneStore + UIHost` 全内存运行十五链：冷渲、连发即时、DOM 同步、V/P/E 快捷键、框选多选、批量移动、缩放、旋转、复制粘贴、Alt 拖、图片粘贴、橡皮撤销、删除撤销、后台冲刷、console clean。

所有轮询使用 `setTimeout`，不依赖隐藏标签页会停摆的 `requestAnimationFrame`。输入先同步进入 SceneStore；验收观察者只等待 React commit 与后台冲刷，不把等待塞回产品交互路径。

## 运行

```bash
npm run acceptance:canvas
```

- `http://127.0.0.1:4518/?size=300`
- `http://127.0.0.1:4518/?size=800`
- `http://127.0.0.1:4518/?mode=interaction`

机器探针统一为 `window.__CANVAS_ACCEPTANCE__`；interaction 可用可见按钮手动启动，也可加 `&autorun=1`。

另开终端运行自动门：

```bash
python3 tests/fixtures/canvas-acceptance/verify.py --suite canvas
# 或先以 npm run acceptance:prod 启动服务，再运行：
python3 tests/fixtures/canvas-acceptance/verify.py --suite prod
```

`--suite prod` 先以只读 graph/EventSource stub 启动真实 production 入口，再在 fresh context 运行十五链；两段都要求 console error/warning、page error、失败请求、外联与 `/api` 资源为零。

隔离闸门：

```bash
curl -i http://127.0.0.1:4518/api/probe
```

唯一合格结果是 `403 Forbidden`。

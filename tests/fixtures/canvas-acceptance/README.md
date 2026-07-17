# 画布静态世界实机验收夹具

这个夹具有两种隔离模式：默认 performance 验证真实 `ReactFlow + InkWorldLayer + Excalidraw exportToSvg`，`?mode=interaction` 动态加载真实 `FlowCanvas + UIHost + Excalidraw`。它只绑定 `127.0.0.1:4518`，使用确定性内存数据，不请求 4517，不读取或写入 `data/`。只有 4518 synthetic 画布允许坐标拖拽；真实 4517 仍严禁自动拖拽。

LE-014 另有严格 production 汇合模式：`npm run acceptance:prod` 的 `/` 是真实 `web` production entry，`/?mode=interaction` 是同一次 4518 静态服务中的 synthetic interaction build。两个 build 的同名资产只有字节完全相同才允许合并；各自真实 subset worker 入口都必须被识别并只在 worker 响应上获得专属 CSP。production 页面只允许 `web/index.html` 的固定 bootstrap，其 UTF-8 内容必须逐字为 `window.EXCALIDRAW_ASSET_PATH = '/';`，`script-src` 只以精确 SHA-256 放行它，不含 `unsafe-inline` 或普通 `unsafe-eval`。

## 启动与探针

```bash
npm run acceptance:canvas
```

打开以下任一地址，等待页面状态变成 `pass` 或 `fail`：

- `http://127.0.0.1:4518/?size=300&autorun=1`
- `http://127.0.0.1:4518/?size=800&autorun=1`
- `http://127.0.0.1:4518/?mode=interaction`

机器探针是 `window.__CANVAS_ACCEPTANCE__`，同时镜像到 `html[data-acceptance-status]` 与 `html[data-acceptance-report]`。完成时页面会发出 `canvas-acceptance-complete` 事件。

`tests/canvas-browser.test.mjs` 会在 production static 4518 上依次重跑 300/800 两档。页面 CSP 不含 `unsafe-eval`，只有构建后识别出的真实 subset worker 入口响应拥有 worker 专属 `unsafe-eval + wasm-unsafe-eval`；验收同时要求 Worker 请求真实出现、页面自身 `status=pass`、全部 checks 与 paint 后采样为真，并且 console/page error、warning、外联与 API 资源均为零。

`tests/prod-boot.test.mjs` 是独立的 production convergence gate。第一个 fresh Chromium context 在任何应用代码前注入只读的最小 graph fetch 与 `/api/events` EventSource；真实 `.canvas-root` 必须可见，graph 恰好读取一次、EventSource 恰好创建并打开一次，真实 API/外联/失败请求、console warning/error、page error 与 TDZ/ReferenceError 全为零。第二个 fresh context 打开既有 `/?mode=interaction`，直接读取真实 `window.__CANVAS_INTERACTION__`，并独立要求 `concurrent/revision/opening/closing/coldError/warmError/lateIsolation` 七条 production 链及 DOM 镜像全部 PASS。closing 最终 revision 若零导出，只能由同一次 closing 的较早成功组导出与最终 persisted drawing 签名精确相等来证明复用。

分层闸门固定为：

1. `npm run build`：production build 与 subset-worker 递归闭包；
2. `tests/canvas-browser.test.mjs`：300/800 paint/performance/worker；
3. `tests/prod-boot.test.mjs`：真实 production boot 与七条 interaction 链；
4. `npm run verify:global`：先 build，再一次性串行执行全部 `tests/*.test.mjs`，脚本不递归调用自身或 `npm test`。

Computer Use 截图、4517 只读 console 和候选 manifest 都是候选外部的观察/裁决层；本夹具、本测试与候选不得生成或收集这些证据，也不得触碰真实数据、launchd 或远端。

交互模式只读探针是 `window.__CANVAS_INTERACTION__`，镜像到 `html[data-interaction-*]`：绘图总数与沉/浮面、action/commit log、选中 synthetic card、viewport、API resource 数以及 `pointerup → drawing-opening` 延迟。延迟探针只观察 pointerup 后 100ms：超时立即清空候选，因此小形状或已有元素稍后手动退出不会冒充自动退场。探针没有修改方法；所有验收动作必须通过真实 UI。`drawingCommit` 原样回写同一组 elements/files 引用，才能真实覆盖三真相收口。

交互验收顺序：画大实心 rectangle/ellipse/diamond 后退场延迟 `<100ms`、单次 commit 且 below；点击被覆盖会话卡；toast 撤销；右键浮起/沉底；小形状/透明形状/selection 编辑不自动退；滚轮/捏合/平移相机不新增 commit。最后要求 console error/warning 为零、API resource 数为零。

隔离闸门必须独立检查：

```bash
curl -i http://127.0.0.1:4518/api/probe
```

唯一合格结果是明确的 `HTTP/1.1 403 Forbidden`；返回夹具 HTML 即隔离失败。

## 固定红线

| 规模 | 首帧最大值 | 20 次单沉层变更 p95 | 单次最大值 | warm long task 最大值 |
| --- | ---: | ---: | ---: | ---: |
| 300 | 500ms | 50ms | 100ms | 50ms |
| 800 | 500ms | 100ms | 125ms | 100ms |

两种规模还必须同时满足：同槽同签名在途只 `join` 不重复导出、ready 同内容零导出、每次 warm 只导出 `below` 的 1 个连续 z-order group 并复用其余 groups 与整个 `above`、60 帧视口漂移 p95 ≤ 0.25px / max ≤ 0.5px、帧间隔 p95 ≤ 20ms / max ≤ 50ms、浏览器支持 Long Tasks API、页面异常为零。报告中的 `groupCounts` 是实际 `exported/joined/reused/cleared` 组数，不以平面级兼容字段冒充局部更新。

## 2026-07-15 连续 group 架构实机基线

最终 48 元素/组、全帧单一 font capsule 的代码，在隔离 4518 上实测：

- 300 元素：cold 419.9ms，warm p95 12.1ms、max 12.4ms；每面 4 组，单次只新导出 below 1 组。
- 800 元素：cold 400.3ms，warm p95 14.8ms、max 20.4ms；每面 9 组，单次只新导出 below 1 组。
- 早期唯一字“Q→Z”使 font `exported=1`，同内容下一帧 `reused=1`；两字符均受夹具字体支持，避免零字形 WOFF2 噪音。DOM 只有一个 `style[data-ink-fonts]`，几何组内 `@font-face` 数为 0，胶囊同时含 Virgil 与 Excalifont。
- 两档视口漂移 max 0.0041px、页面异常 0、全部检查 PASS。

被证伪的方案也保留：每组重复内联字体时 300 cold 587.4ms；“末个文字组持有字体”会漏掉早期组独有字符，因此即使性能过线也按正确性 FAIL。没有放宽红线，也没有用文案掩盖缺口。生产 build 另由 subset-worker 递归闭包硬门守住，不以 console 过滤或关闭 Worker 过关。

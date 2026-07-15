# 画布静态世界实机验收夹具

这个夹具只验证真实 `ReactFlow + InkWorldLayer + Excalidraw exportToSvg` 链路，不模拟导出器。它只绑定 `127.0.0.1:4518`，使用确定性的 300/800 元素内存数据，不请求 4517，不读取或写入 `data/`，也不执行真实画布坐标拖拽。

## 启动与探针

```bash
npm run acceptance:canvas
```

打开以下任一地址，等待页面状态变成 `pass` 或 `fail`：

- `http://127.0.0.1:4518/?size=300&autorun=1`
- `http://127.0.0.1:4518/?size=800&autorun=1`

机器探针是 `window.__CANVAS_ACCEPTANCE__`，同时镜像到 `html[data-acceptance-status]` 与 `html[data-acceptance-report]`。完成时页面会发出 `canvas-acceptance-complete` 事件。

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
- 早期唯一字“龘→靐”使 font `exported=1`，同内容下一帧 `reused=1`；DOM 只有一个 `style[data-ink-fonts]`，几何组内 `@font-face` 数为 0，胶囊同时含 Virgil 与 Excalifont。
- 两档视口漂移 max 0.0041px、页面异常 0、全部检查 PASS。

被证伪的方案也保留：每组重复内联字体时 300 cold 587.4ms；“末个文字组持有字体”会漏掉早期组独有字符，因此即使性能过线也按正确性 FAIL。没有放宽红线，也没有用文案掩盖缺口。font capsule 不等于生产 worker fallback，后者仍是独立后续硬门。

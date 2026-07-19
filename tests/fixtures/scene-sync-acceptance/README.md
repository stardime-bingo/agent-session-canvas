# SceneStore 双标签 / daemon / pagehide 隔离验收

验收器创建临时 data dir 和临时本机端口，启动只包含真实 `server/scene.mjs`、SSE 与静态夹具的 scene daemon。浏览器页复用 production `scene-store.js`、`api.js` 与 `TopBar` 同步状态点；不启动 scanner，不读取仓内 `data/`，不接触 4517、launchd、`~/.claude` 或 `~/.codex`。

覆盖：

- 两个独立 browser context：干净标签静默采纳远端 LWW；脏本地拒绝远端覆盖，随后自己的后台冲刷成为最后写并让双方收敛。
- daemon 暂停/恢复：浏览器输入继续同步可见，状态点进入 `dirty/error`；同一临时 data dir 重启后无限退避自动追平并回到 `saved`。
- pagehide：既测 300ms 防抖前立即关闭，也测普通 flush 已在飞后再次输入最终文字并关闭；`flushNow` 以 fetch keepalive 发送最新 clientSeq，旧请求不得倒灌，重开后最终文字仍在。

运行：

```bash
python3 tests/fixtures/scene-sync-acceptance/verify.py
```

机器报告写入被 Git 忽略的 `output/acceptance/`。服务端故意把场景响应延迟 150ms，使关闭标签用例能真实区分普通 fetch 与 keepalive。

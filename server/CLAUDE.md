# server/
> L2 | 父级: ../CLAUDE.md

零依赖 Node 后端 daemon：扫描本地会话地形、拉起终端、调用 AI、对前端供图。

成员清单
index.mjs: HTTP 总入口(:4517 仅本机)，路由表驱动 API（/api/session 同时返回开场 digest 与独立尾部 endingDigest）+ SSE 广播(图签名 diff：会话增删/状态翻转/改名/接力产出才举旗，
  纯 mtime/体积增长静默——治"有新活动"常亮) + fs.watch 防抖重扫 + 静态托管 web/dist。
  路由族: layout(存/清/批量,含 w/h)/backfill/name(单会话AI起名)/delete(移废纸篓+清增强+清血缘)/
  手绘层(edge/note/board → data/canvas.json)/ws-rename(工作区别名)/rename(看板层+按原生格式写回本体:
  claude=会话文件尾追加 custom-title 行【10 分钟活跃门禁,热文件不动本体】，codex=session_index.jsonl 追加 last-wins 行)。
  安全律: delete 有 10 分钟活跃门禁+force 破门+如实报成败；SSE 30s 心跳清死连接；process 级 uncaught 兜底；
  缓存脏检查(store.saveCache 零变化不落盘)；手动改名写回 Codex 索引后读尾校验——解析器变更仍必须递增 CACHE_VERSION
scanner.mjs: 扫描编排核心，三层噪音过滤(自噪/子智能体/空壳) + automation 同任务多次运行折叠成聚合卡(runs/runFiles) + 三种关联边：worktree(路径)、family(名字亲缘+泛化名/当前系统用户名动态停用+族上限8)、handoff(launch 血缘 15 分钟窗口)
store.mjs: 持久层，DATA_DIR 常量 + 原子 JSON 读写；扫描缓存(scan-cache.json)进程内常驻，AI 增强(enrich.json)
  以跨进程文件锁包住“读最新值→改→原子写”，避免 daemon 与 backfill CLI 旧快照互相覆盖；JSONL 追加后读尾校验
launcher.mjs: 终端拉起，COMMANDS 查表构造命令，prompt 走临时文件注入避开引号地狱，Ghostty 优先 Terminal.app 兜底
llm.mjs: 模型路由层，codex(gpt-5.6-sol)→claude(sonnet-5)→deepseek(v4-flash) 按序降级；codex exec 用 --ephemeral 防自噪；档位 xhigh/high
ai.mjs: 认知层。extractDigest 三流事件抽取(对白+工具轨迹+报错现场，含 Codex function/custom_tool_call)，轻档(命名/摘要)读首尾、深档(接力)加中段切片共 ~900KB 窗口；
  extractEndingDigest 从文件尾独立保住最后16个事件，供详情的停止点显示，不受总 digest 前向截断；
  模型 JSON 回包按引号/转义/括号深度提取首个完整对象，不用贪婪正则吞并相邻对象；
  makeHandoff 哲学=给地图和考古线索不给圣旨：九节交接文档(协作约定/任务本质/按序读路径/已完成附验证/尝试与失败考古/精确状态/未竟/铁律/小事记账)，
  不设字数上限，反幻觉纪律(指路牌不快照、待验证标注、禁编造)
backfill.mjs: 批量人话化流水线，近 30 天 + title===firstPrompt 判机器标题，3 并发逐条落盘，CLI 与 API 双入口
adapters/: 各 Agent 工具适配器，见其 CLAUDE.md

依赖方向: index → scanner/launcher/ai/backfill → llm/adapters/store，单向无环。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

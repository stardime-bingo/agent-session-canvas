# 文档索引

这里仅保留公开产品文档、提交文案和有长期价值的工程决策记录。运行时数据、构建产物与本地验收原始证据不进入 GitHub。

## 当前文档

- [Codex Marketplace Submission Copy](./codex-marketplace-submission.md)：官方目录提交所需的公开文案、测试用例与发布说明；不代表已经获批或提交成功。
- [Privacy Policy](../PRIVACY.md)：本地读取、保存、AI 调用与可选钩子的隐私边界。
- [Terms of Use](../TERMS.md)：公开使用条款。
- [README](../README.md)：安装、启停、画布操作、数据边界与开发入口。

## 归档工程记录

- [绘图融合根治计划 v2](./绘图融合根治计划-v2.md)：LE-011R～LE-014 已完成的架构决策与验收合同。该文件保留原路径以维持 `.loop/backlog` 的证据引用，状态冻结，不再作为进行中 backlog。

## 本地保留但不发布

- `data/`：真实运行时资产与日志，始终忽略，不纳入版本控制。
- `.loop/v2/`、`.loop/history/`：本地验收状态与历史证据，始终忽略；已完成任务的证据不因工作区整理而删除。
- `web/dist/`、`web/public/fonts/`、`node_modules/`：可重建的构建或依赖目录，始终忽略。

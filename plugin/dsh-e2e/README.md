# dshE2E

基于 `e2e@0.19.0` runner 的 DeepSeek Harness 插件，与 dshHarmony 共用鸿蒙设备管理和控制权。

- 根据目标和验收条件执行手机流程，或验证当前页面。
- 保存报告、关键截图和目标应用日志，按会话查看历史。
- 复用已通过流程、调整后复测，保留原报告。
- 会话日志工作台支持离线导入、筛选、搜索和生成 AI 分析草稿。

当前源码版本 **0.4.0-rc.2（候选版）**，配套 dshHarmony **0.5.0-rc.2**；运行环境为 Windows、DSH **0.2.0-rc.2**、Node **24**。稳定版本仍为 0.3.1/0.4.3，安装时明确选择版本。

| 文档 | 内容 |
|---|---|
| [使用说明](USAGE.md) | 对话触发、操作范围、日志、复用与复测 |
| [安装指南](INSTALLATION.md) | 配套安装、运行时与 profile |
| [AI 安装指南](AI_INSTALLATION.md) | 安装步骤、备份与恢复 |
| [面板指南](../../docs/PANEL.md) | 会话工作台与报告界面 |
| [日志指南](../../docs/LOG_WORKBENCH.md) | 会话日志库和分析草稿 |

运行资料保存在 `<DSH_HOME>/storages/dshE2E`，不随源码提交。适配许可为 [Apache-2.0](LICENSE)，完整来源见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

[返回工具集](../../README.md)

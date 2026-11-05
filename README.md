# dshHarmony 与 dsh-log-analysis

鸿蒙设备投屏和日志分析工作台。当前配对RC版本为 **0.6.0-rc.1**。

[下载0.6.0-rc.1](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.6.0-rc.1)。从旧dshVerify升级时，需迁移实际包登记；请先阅读安装与AI升级指南。

- **日志分析**：会话日志导入、编码识别、ZIP/GZ/RAR解析、Notepad++式跨文件查找、加入对话和跨会话清理。
- **dshHarmony**：设备投屏、手工操作、截图录屏与批注、实时日志和保存到会话。

不再提供AI操控手机工具或开发验证框架。加入对话用于日志分析，只写草稿，保留人工发送。

明文1GiB、压缩包2GiB、累计展开8GiB；这些是不同预算，页面/行/搜索worker也有独立预算，超限会明确提示。

[自审验收](docs/LOG_ANALYSIS_SELF_REVIEW_20261105.md) · [安装与AI升级](docs/LOG_ANALYSIS_UPGRADE.md) · [日志工作台](docs/LOG_WORKBENCH.md) · [Claude规划](docs/LOG_ANALYSIS_PLAN_20261105.md)

源码目录plugin/dsh-e2e和数据目录storages/dshE2E沿用历史名称；安装身份为dsh-log-analysis。旧数据不自动搬迁或删除。

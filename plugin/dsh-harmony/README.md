# dshHarmony

DeepSeek Harness 的鸿蒙设备与调试工作台，基于 Piora 源码适配。

- 手机观察、点击、输入、应用与文件管理。
- 原生 H.264 投屏、截图、独立 MP4 录像。
- 实时 HiLog 筛选、搜索、查看与保存。
- 与 dshE2E 共用设备管理和控制权；日志可保存到当前会话。

当前源码版本 **0.5.0-rc.4（候选版）**，配套 dshE2E **0.4.0-rc.3**；运行环境为 Windows、DSH **0.2.0-rc.2**、Node **24**。稳定版本仍为 0.4.3/0.3.1，安装时明确选择版本。

DevEco 退出后仍可能在手机留下投屏进程。遇到占用时，确认原投屏不再使用，再在面板选择“释放占用并重连”；插件核实 PID 和启动时间后只释放该进程。不会自动抢占外部投屏，详情见 [恢复与验收](../../docs/VIDEO_RECOVERY_PLAN.md)。

| 文档 | 内容 |
|---|---|
| [使用说明](USAGE.md) | 设备连接、投屏、日志与 AI 操作入口 |
| [安装指南](INSTALLATION.md) | 环境要求、两插件配套安装与启动 |
| [AI 安装指南](AI_INSTALLATION.md) | 身份确认、备份、安装、恢复 |
| [视频说明](../../docs/NATIVE_VIDEO.md) | 原生视频资源与使用边界 |
| [日志说明](../../docs/LOG_WORKBENCH.md) | 实时日志与会话日志工作台 |

配置与缓存位于 `<DSH_HOME>/storages/dshHarmony`。源码路径迁移不会移动运行数据。源码许可和来源见 [LICENSE-Piora](LICENSE-Piora)、[UPSTREAM.json](UPSTREAM.json) 与 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

[返回工具集](../../README.md)

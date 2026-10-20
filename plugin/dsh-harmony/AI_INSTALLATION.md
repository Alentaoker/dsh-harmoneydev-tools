# 让 AI 安装或升级 dshHarmony

当前配套版本：dshHarmony **0.5.0-rc.9** + dshVerify **0.5.0-rc.2**；精确 tag：`v0.5.0-rc.9-e2e-0.5.0-rc.2`，Windows x64 / DSH 0.2.0-rc.2 / Node24，RC 预发布。Verify 安装标识仍为 `dsh-e2e`。

将下面一段交给另一台电脑上的 AI：

> 请将本机 DSH 的两个插件配套升级至 v0.5.0-rc.9-e2e-0.5.0-rc.2。从 Alentaoker/dsh-harmoneydev-tools 的该 Release 下载 windows-source.zip 与同名 .sha256，校验后读取包内 docs/AI_UPGRADE.md 和 docs/AI_INSTALLATION.md。先发现这台电脑的 EXE、CLI、真实 Node24/npm、原 DSH_HOME、目标 profile 和旧来源；备份登记与日志库并保留旧来源。使用新的长期目录，PlanOnly 通过且完整退出相关宿主后再安装，Harmony → Verify 构建并通过正式 CLI 登记；desktop/web 分别处理。同环境冷启动，核对版本、全部会话管理、旧日志和草稿；仅预览清理范围后取消。保留其它插件、模型配置、凭据、会话和用户文件，不复制另一台电脑的 Data，不升级宿主或添加兼容豁免。分别报告构建、登记、运行和设备待验项，失败按指南恢复。

[完整 AI 安装指南](../../docs/AI_INSTALLATION.md) · [AI 升级与回退](../../docs/AI_UPGRADE.md) · [安装指南](INSTALLATION.md)

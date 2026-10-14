# 让 AI 安装或升级 dshHarmony

把下面这段交给有权访问本机与私有仓库的 AI，并填写版本和路径：

> 请从 Alentaoker/dsh-harmoneydev-tools 的指定提交或 tag 安装/升级 dshHarmony 及其配套插件。先读取本目录 INSTALLATION.md 和仓库 docs/AI_INSTALLATION.md。确认 DSH 0.2.0-rc.2、Node 24、实际 DSH_HOME、目标 profile 与插件版本；备份原登记并保留旧来源。使用新 plugin/ 路径执行只读预检，构建两个插件后通过正式 CLI 登记，再用相同环境冷启动。保留其他插件、模型、会话和本地数据；失败按备份恢复本次改动。分别报告文件登记、宿主启用、设备功能哪些完成、哪些未做。不要顺带安装 skill、升级 DSH 宿主或改兼容豁免。

配套步骤共用一份 [AI 安装、升级与恢复指南](../../docs/AI_INSTALLATION.md)，以免两份安装流程发生漂移。插件包名仍为 `dsh-harmony`，不能用仓库名代替。若安装来源仍是旧仓库目录，不移动已被运行宿主引用的目录；先准备新来源，再重新登记。

[安装指南](INSTALLATION.md) · [返回介绍](README.md)

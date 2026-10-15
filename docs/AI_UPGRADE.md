# AI 升级指南

目标配套版本：dshHarmony 0.5.0-rc.4 / dshE2E 0.4.0-rc.3。适配 Windows x64、DSH 0.2.0-rc.2、真实 Node24；其它宿主版本停止自动升级，先单独适配。完整安装参数见 [AI 安装指南](AI_INSTALLATION.md)。

## 先确认现状

1. 明确用户选择的版本、源码 tag/SHA 或 ZIP SHA256。候选版不能静默当作稳定版。
2. 核对实际桌面 EXE/CLI、Node/npm、DSH_HOME、profile 和已安装包的真实目录。检查正在运行进程的 profile 参数；当前终端环境、端口和 package.json 版本不能证明正在使用新版。
3. `node scripts/verify-install.mjs '<DataHome>\profiles\<profile>'` 记录原版本和源目录；读取必要字段，不输出密钥、登录状态、完整会话或归属令牌。
4. 新仓库是 `Alentaoker/dsh-harmoneydev-tools`，源码目录为 `plugin/`。从旧 `plugins/` 迁移时核对 [目录迁移说明](REPOSITORY_MIGRATION.md)，不按新名称推导 npm 包名。

## 准备与安装

- 确认设备任务/录像已结束，保存未发送草稿并完整退出目标宿主。用户已授权升级时不重复请求升级权限；未能自动正常退出时明确说明并请用户完成退出。
- 在原 DSH_HOME 的 backups 下保存 profile 的包清单、锁、composition 和兼容配置；另外保留旧插件源码/runtime。备份不上传，运行数据、供应商和密钥不覆盖。
- 推荐把校验过的发行包解压到新的、长期保留的来源目录。对它执行 `scripts/install.ps1 ... -PlanOnly`；显式指定原 DataHome/profile，验证 Node24、npm、精确宿主版本、manifest 和原生资源。
- 去掉 PlanOnly，成对安装构建两包，再通过正式 CLI 登记；最后增量确认 bundle 并执行 verify-install。任一步非零停止，不升级宿主、不写兼容豁免、不删整个数据目录。
- 发行文件的 `release-manifest.json` 用于检查原始源码。开始依赖安装/构建后，生成的 ignored 输出不属于发行源码；不要为了让校验通过改写原 manifest。

## 冷启动与验收

本轮由 Harmony 0.5.0-rc.3 / E2E 0.4.0-rc.2 升至 0.5.0-rc.4 / 0.4.0-rc.3。宿主、peer、日志协议 2 和原生视频资源保持不变；新增纯 JS ZIP 读取依赖 yauzl 3.4.0。必须成对重建并冷启动，不能运行中覆盖客户端或后台线程文件。

旧日志在首次阅读时建立分块索引；旧原文和 JSONL 保留以便兼容，新导入使用 blocks-v1。升级前备份日志库；回退旧插件不会理解新分块文件，应恢复备份或从原文件重新导入，不能宣称只回退插件即可读取新增数据。目录、收藏和解析工具配置均位于原 DataHome 的日志库中。

1. 使用 `start-desktop.ps1 -DshExe ... -DataHome ... -E2ENode ...`，确认实际进程使用原环境。web profile 独立登记，不能由桌面安装推断已升级。
2. 查看实际面板/工具入口，无 fatal load failure；核对版本及当前会话。先做只读检查，再在独立验收会话验证授权的关键操作。
3. 会话日志协议必须是 2；缺会话或旧 E2E 时拒绝保存，不能回退全局库。验证导入、原始字节/行号、会话切换、保存桥接、批量删除/恢复、简洁分析草稿和已有草稿保留。
4. DevEco 等外部投屏仍占用时，核对来源/PID；不中断未获授权的外部任务，不批量杀 uitest，不强删活服务记录。释放后的 H.264 及多窗口共享另行实测。
5. 新的干净 web profile 需要正常完成其认证；401/403 表示认证门禁生效，不要关闭门禁来验收。未完成认证不能宣称其插件接口或 UI 全部通过。
6. 将依赖/登记、冷启动、UI、真实设备/模型分别报告。无手机、模型额度不足、原生拖放未验或另一台实体电脑未验，明确列为 Pending；模拟测试不替代这些结果。

## 回退

完整退出宿主，正式登记回保留的旧来源目录，增量核对原 profile 的 bundle/composition，再同环境冷启动。仅恢复本次拥有字段，保留用户升级期间新增配置。

保留日志库 sessions/trash、旧共享日志与 E2E 报告。旧版本可能不显示新目录，不能据此删除数据。回退只恢复插件版本，不复制别人的密钥/设备序列号或整个数据目录。

## 交付记录

报告目标版本与源码 SHA/ZIP hash、宿主/Node、DataHome/profile、真实插件目录、备份位置；列出 Completed / Pending / Rollback。源码、检查通过、安装完成、运行已启用是不同状态，不互相替代。

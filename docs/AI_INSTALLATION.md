# AI 安装与升级操作指南

适用对象：帮助使用者安装本仓库的 AI Agent。按顺序执行，逐项记录证据。成功必须同时满足：**构建成功、宿主实际启用、真实功能可用**。仅看到包清单、面板或 README 不算安装完成。

本指南结合 [dsh-plugin-upgrade-skill / plugin-upgrade](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/blob/main/skills/plugin-upgrade/SKILL.md) 的检查、备份、迁移和验证流程。该 Skill 是给 Agent 的操作指导，不是 DSH 运行时插件，也不能自动保证兼容。

## 1. 只读确认身份与安装目标

记录以下信息，不读取登录令牌、密钥文件或完整宿主会话日志：

- 仓库远端必须是使用者授权的私有仓库；当前项目为 `Alentaoker/dsh-harmony-e2e`。记录 `git rev-parse HEAD`，不要把 GitHub 项目名当作 npm 包名。
- 插件包分别为 `dsh-harmony` **0.3.0**、`dsh-e2e` **0.2.0**；DSH 宿主版本单独记录。目前验证目标是 Windows / **DSH Desktop 0.2.0-rc.2**，不是其他 DSH 版本的兼容承诺。
- 明确 DSH 可执行文件、CLI 绝对路径、`DSH_HOME` 和目标 `desktop`／`web` profile。先运行过该宿主，使目标 profile 已初始化。
- 核对启动进程实际使用的 profile 路径；不要因为端口不同就判断数据环境不同，也不要从当前终端变量推断已运行进程的环境。
- 插件源码目录、实际安装目录、profile 的依赖引用和 bundle 列表分别检查。目录安装／链接安装更新原目录；不要覆盖其他插件、供应商、会话或未知配置字段。
- 使用 **Node 24**。安装脚本可显式传 `-NodeExe` 和 `-NpmCli`，避免系统默认 Node 20 或 npm 包装器使用另一个运行时。

用户已经明确要求安装或升级时，在此授权范围内完成工作。若用户只要求分析，先提供具体计划，不修改安装环境。不擅自升级 DSH 宿主、替换模型或改成公共仓库，不用裸 `latest`。

## 2. 安装预览与备份

在仓库根目录运行以下预览，路径按实际环境替换：

```powershell
.\scripts\install.ps1 `
  -DshCli 'E:\DeepSeekHarness\App\resources\runtime\cli\bin\dsh.cmd' `
  -DataHome 'E:\DeepSeekHarness\Data' -DshProfile desktop `
  -NodeExe 'E:\DeepSeekHarness\App\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' `
  -NpmCli 'E:\Nodejs\node_modules\npm\bin\npm-cli.js' -PlanOnly
```

`PlanOnly` 只解析目标路径并输出计划，不安装依赖、不注册 bundle、不改 profile。确认输出对应用户希望使用的环境。

完整退出目标宿主，确认没有活动手机测试。安装脚本备份目标 profile 的 `package.json`、已有 pnpm 锁文件及 composition 配置到 `$DSH_HOME/backups`。它不备份密钥或完整会话，也不自动回滚。

更新既有独立安装目录时，另备份这两个插件原有的发行文件，记录本次修改范围。不要使用会产生 `lib/lib`、`resources/resources` 的目录套目录复制。若采用源码链接安装，记录旧 Git 提交和未提交修改，再更新原目录。

## 3. 构建与安装

去掉上例的 `-PlanOnly`，执行安装脚本。它用固定 Node 运行 npm，依据各插件 lockfile 安装依赖，先构建／注册 Harmony，再构建／注册 E2E，最后以增量方式补充两个 bundle。

检查每一步退出码；任一步失败就停止。保持其他依赖、composition 未知字段和用户自定义插件。宿主 profile 的 pnpm 锁文件与插件源码的 npm 锁文件作用不同，不互相替换。

不要用原本机 Piora、e2e 源码目录作为隐式构建依赖；本仓库包含必要的 vendored 来源。内嵌的视频二进制需通过固定哈希校验；不需要运行 DevEco Testing，HDC、驱动和手机授权仍必需。原厂组件只随这个私有自用项目使用，不扩大其分发许可。

## 4. 同环境冷启动

```powershell
.\scripts\start-desktop.ps1 `
  -DshExe 'E:\DeepSeekHarness\App\DeepSeek Harness.exe' `
  -DataHome 'E:\DeepSeekHarness\Data'
```

启动前从应用菜单完整退出旧实例。已运行的 Electron 实例可能仍使用旧环境或旧后端；重复启动、关闭窗口、刷新前端都不能作为完整重启证据。

网页版要安装到 `web` profile，并以同样的 `DSH_HOME` 启动。不要同时用两个宿主控制同一手机。不能为了“统一环境”删除 C 盘或 E 盘已有用户数据。

## 5. 分层验证

1. **依赖和构建**：两个插件 manifest 版本、依赖安装、构建退出码。合适时运行仓库模拟测试；测试 `DSH_HOME` 使用独立临时目录，不能污染用户报告。
2. **实际启用**：核对 profile 的依赖引用与 bundle；冷启动没有 fatal load failure。插件列表、会话入口、工具注册均正常，不只看文件存在。
3. **设备连接**：选择正确的 `hdc.exe`；HDC 显示具体在线设备，插件也显示在线。锁屏有认证时让用户在手机上处理，不读取或保存密码。
4. **消息 → 工具 → 结果**：在新的验收会话调用 `e2e_phone.status`，再运行一个有明确断言的只读任务。需要日志时先 `resolve_app` 查询真实目标；`logAppBundle` 只绑定日志，`appBundle` 才会停止并启动应用。
5. **报告与正文**：执行后 `get_report`、`get_logs`，检查真实状态、证据文件、日志采集、水位和截断警告。明确区分 UI 通过与日志采集成功。
6. **面板路径**：检查当前会话隔离、通过／未通过筛选、报告四页、截图实际显示、日志分页、调整复测产生新 ID 和关联。原报告必须保留。
7. **取消和收尾**：测试取消没有继续派发输入，控制权有真实释放结果，后续测试能继续。宿主重启后的未完成记录应显示中断；旧控制释放状态不能推断为成功。

确定步骤不调用手机规划模型，外层 AI 的会话调用仍计入供应商额度。自然语言步骤使用当前会话模型；额度耗尽属于模型服务问题，不能改报应用缺陷。

## 6. 失败时的恢复边界

保存失败阶段、退出码、版本、源码提交、安装路径、备份位置及已修改文件。不要把完整日志、用户截图、序列号或凭据提交到 GitHub。

停止本次运行，确认控制释放；修复自己有源码的插件或应用后，明确创建复测。没有第三方应用源码时不宣称已修复其内部缺陷。

需要恢复时，只恢复本次拥有的插件发行文件和 profile 中这两个插件的依赖／bundle 配置；对照备份合并，保留备份之后用户新增的其他插件。不要直接覆盖整个 profile 或用户数据目录。第三方安装脚本、依赖及宿主状态不保证能自动回滚。

最终交付应包含实际版本与提交、安装环境、验证结果、仍未验证的范围和恢复位置。功能失败时保留失败报告，不用改断言掩盖原测试失败。

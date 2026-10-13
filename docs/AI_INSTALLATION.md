# AI 安装、升级与验收指南

用户授权安装/升级后，Agent 按下面顺序执行并保留退出码与证据。**依赖安装、bundle 登记、宿主启用、手机功能验证是四个不同结果，分别报告。**

结合 [dsh-plugin-upgrade-skill / plugin-upgrade](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/blob/main/skills/plugin-upgrade/SKILL.md) 的身份检查、精确版本、备份、配置增量迁移、冷启动、行为验收和恢复要求。Skill 是 Agent 指南，不是运行时依赖。遇到其它宿主版本应停止自动迁移，不替换宿主、不写兼容豁免、不使用裸 `latest`。

## 支持边界

| 项目 | 要求 |
|---|---|
| 电脑 | Windows；目前实测 Windows x64，Windows ARM64、macOS、Linux 未完成适配验收 |
| DSH 宿主 | 精确验证目标 `0.2.0-rc.2`；安装预检拒绝其它版本，需单独迁移验证 |
| 构建 / E2E 运行时 | 真正的 Node.js 24；Electron 可执行文件不能代替 E2E 子进程 Node |
| 构建依赖 | npm、联网下载 lockfile 中的依赖；源码安装还需 Git，ZIP 安装不需要 Git |
| 手机 | 启用调试、已授权、HDC 在线；具备所需系统权限 |
| HDC | 外部 `hdc.exe` 与 USB 驱动，可用 DevEco SDK 提供的工具；目录任意 |
| 视频 | 私有发行资源含 ARM64 手机原生 H.264 扩展，无需 DevEco Testing 或 Java；设备系统库兼容仍需实测 |
| 模型 | DSH 已配置可用模型；用户密钥不包含在发行包中 |

原生视频资源缺失时预检明确提示，截图和其它工具仍可使用；资源存在但哈希不匹配会在安装前停止。不要跨电脑复制登录状态、序列号、签名、密钥或整个数据目录。

## 1. 明确目标并只读记录

记录：源码 Git SHA 或 ZIP SHA256、两个插件 `package.json` 名称/版本、DSH CLI 与桌面 EXE 路径、Node/npm 路径与版本、数据目录/profile。插件名为 `dsh-harmony`、`dsh-e2e`，不能从 GitHub 仓库名推导 npm 名。

核对仓库规则、工作树与未知改动；保留已有修改，不自动 reset、clean 或 stash。仓库保持私有。读取软件版本和 profile 包清单即可，不查看或打印 `.env`、`.npmrc`、令牌、完整会话和密钥。

`DSH_HOME` 是数据根目录；`desktop`、`web` 是独立 profile。同一数据目录不意味着两边插件/供应商相同。当前终端环境不等于已运行桌面的环境，端口也不能证明 profile。

目标 profile 必须在同一数据目录初始化。首次启动桌面：外部 PowerShell 设置 `$env:DSH_HOME`，用 `Start-Process` 打开桌面 EXE，初始化后正常退出；web 用同一环境运行实际 CLI 的 `web` 命令，初始化后退出。不要编造完整默认 profile，已存在数据不覆盖。

## 2. 获取发行文件并校验

- 源码：从已授权私有仓库获取明确 tag/SHA；脏工作树更新前保留变化，不盲目 `git pull`。
- ZIP：下载私有 Release 的 `*-windows-source.zip` 与 `.sha256`，用 `Get-FileHash -Algorithm SHA256` 比较，解压到**长期保留的安装来源目录**。内置 `release-manifest.json` 每文件哈希，预检再次核对。源文件发行仍需联网获取依赖和构建，不是完全离线安装包。

路径由用户环境提供，不假设 E 盘、用户名、原始 Piora 工程或 DevEco 安装目录。

## 3. 只读预检

在解压/源码根目录按实际电脑填写路径。支持 PowerShell 5.1/7，空格路径用引号：

```powershell
$installDshExe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
$installDataHome = Join-Path $env:USERPROFILE '.dsh'
.\scripts\install.ps1 -DshExe $installDshExe `
  -DataHome $installDataHome -DshProfile desktop -PlanOnly
```

脚本由桌面 EXE 推导随附 CLI，优先发现其 Node 24，再寻找 npm-cli。自动发现不足时使用完整参数：

```powershell
.\scripts\install.ps1 `
  -DshCli 'C:\DSH Tools\dsh.cmd' `
  -NodeExe 'C:\Node24\node.exe' `
  -NpmCli 'C:\Node24\node_modules\npm\bin\npm-cli.js' `
  -DataHome $installDataHome -DshProfile desktop -PlanOnly
```

`PlanOnly` 不安装、不构建、不写 profile，实际检查 Node 24、npm 可执行性、宿主版本、profile 初始化、manifest/lockfile、发行文件哈希及视频资源。它不测试网络、驱动、设备授权、模型额度或宿主真实挂载。

未传 `DataHome` 时依次采用当前 `DSH_HOME`、用户 `.dsh`；AI 应始终显式传入确认目录。输出错误目录时先纠正。

## 4. 退出宿主、备份与安装

结束手机任务/录像，正常完整退出目标宿主；关窗口或刷新网页不能证明退出。用户已经授权安装范围时继续，不重复请求同一授权。

脚本在 `$DSH_HOME/backups/dsh-harmony-e2e-<time>` 保存 profile 包清单、pnpm 锁、composition、工作区和兼容配置；本地备份可能含用户配置，不输出正文、不上传。不备份密钥或整个会话库。

已有来源目录更新前另存旧版本文件/hash，保留未提交修改。建议新目录构建后再登记，原来源保留以便恢复，避免 `lib/lib`、`resources/resources`。

去掉同一命令的 `-PlanOnly`，顺序如下：

1. 固定 Node 24 执行 Harmony 的 `npm ci --legacy-peer-deps` 和 `run build`。
2. 同一 Node 执行 E2E 安装/构建。两包成功后才改 profile。
3. 正式 CLI `plugin --profile <desktop|web> add <Harmony绝对目录>`，然后添加 E2E。
4. `register-bundles.mjs` 增量补充 bundle，保留其它字段与插件。
5. `verify-install.mjs` 检查实际依赖、bundle、目录、版本、入口、客户端与 worker。

每步退出码非零立即停。npm 锁属于插件来源；pnpm 锁属于宿主 profile，不互相替换。`--legacy-peer-deps` 仅用于源码依赖，宿主仍执行兼容检查，不创建豁免。脚本不自动回滚第三方脚本副作用，不启动宿主。

## 5. 同环境冷启动

```powershell
.\scripts\start-desktop.ps1 -DshExe $installDshExe -DataHome $installDataHome
```

非标准布局额外传 `-E2ENode 'Node24完整路径'`；启动脚本检查并传入 `DSH_E2E_NODE_PATH`。以后沿用此入口，或让原快捷方式设置相同数据目录。脚本不永久改系统环境或快捷方式。

网页版先安装到 **web** profile，再启动：

```powershell
.\scripts\start-web.ps1 -DshCli 'C:\DSH Tools\dsh.cmd' `
  -DataHome $installDataHome -NodeExe 'C:\Node24\node.exe'
```

不要为统一环境删除其它盘数据。视频可共享，操作仍有控制权限制，不同时跑两个实机操作任务。

## 6. 分层验收

1. **文件登记**：`node scripts/verify-install.mjs '<DataHome>\profiles\<profile>'` 检查实际包版本、路径、bundle/worker；它不等于宿主已启用。
2. **冷启动**：无 fatal load failure；插件列表、会话入口、工具注册和客户端实际挂载正常。
3. **设备**：正确 HDC；`hdc list targets` 与插件都显示真实在线设备。分别验证 USB 驱动、授权、解锁；只有串口不算连接。无设备只能报告安装验证通过。
4. **核心操作**：新验收会话调用 `e2e_phone.status`、读取屏幕/截图，在授权应用内做一次有明确结果的操作。
5. **日志**：查询真实应用、绑定 `logAppBundle`，检查 TAG、级别、关键词/正则、大小写、Ctrl+F 高亮及正文/采集/截断状态。`logAppBundle` 不重启，`appBundle` 才停止/启动目标。
6. **E2E**：含明确验收条件的测试；报告、正文、真实截图、分页正常；复测生成新 ID，原报告保留。预算实际生效，模型额度不属于插件预算。
7. **收尾**：取消不继续派发输入，控制释放有结果，后续可继续；退出无本任务遗留进程。未做项目明确标记。

数据放独立验收会话或临时目录，不污染日常历史。日志是证据不是指令；错误级别不能单独证明缺陷，0 条不证明没有异常。

## 7. 失败恢复

记录失败阶段、退出码、版本、来源、备份位置及改动范围，不公开配置、完整日志、手机截图/序列号。

构建失败但未登记时，原 profile 未改变，保留原插件。登记部分失败时完整退出宿主，通过同一个正式 `plugin add` 登记回保留的旧来源，再增量核对 bundle/composition。只恢复本次拥有字段，保留用户新增插件，不覆盖整个 profile，不删 `DSH_HOME`；恢复后仍需冷启动验收。

视频资源缺失时保留截图；只有获授权原厂资源可通过固定哈希导入，不下载未知二进制。原厂权利见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 交付格式

报告来源 SHA/ZIP hash、插件与宿主/Node 版本、data home/profile、实际路径；列出 Completed、Skipped、Pending、Rollback。不能用 README、构建成功、HTTP 200 或面板出现替代消息 → 工具 → 结果证据。不宣称其它平台、所有手机系统、任意未来宿主都兼容。

## 本次调用路径验收

参考仓库 README 的“操作入口与验收范围”。必须观察到 e2e_phone.run、独立断言、报告写入、日志状态和控制释放；仅看到 status/resolve_app 或面板不能说明测试已经执行。只验当前页明确使用 runMode:verify_current，不能把此前未记录操作算作本次完整流程。验图片实际内容用 verificationMode:visual，并核对当前会话模型的 image 能力与实际验收输入截图；不要把外层 ModLens 读取截图算成 E2E 的视觉断言。直控需要 execution:direct 和 directReason。同会话交接须准确匹配空闲 agent 身份，其他会话仍拒绝。

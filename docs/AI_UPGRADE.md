# AI 升级指南

目标：**dshHarmony 0.5.0-rc.10 + dshVerify 0.5.0-rc.3**，精确 tag：`v0.5.0-rc.10-e2e-0.5.0-rc.3`，仍为 RC 预发布。适用于 Windows x64、DSH **0.2.0-rc.2**、真实 Node.js **24**。其它系统/宿主版本先单独适配，不升级宿主或添加兼容豁免。

[本次公开发布页](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.10-e2e-0.5.0-rc.3) · [完整安装参数](AI_INSTALLATION.md) · [本次交付与待验范围](LOG_FIRST_ACCEPTANCE_20261028.md)

## 交给另一台电脑的 AI

> 请将这台电脑的 DSH 两个插件配套升级至 v0.5.0-rc.10-e2e-0.5.0-rc.3。从 Alentaoker/dsh-harmoneydev-tools 该 Release 下载 windows-source.zip 与同名 .sha256，校验后读取包内 docs/AI_UPGRADE.md 和 docs/AI_INSTALLATION.md。先发现本机 EXE、CLI、真实 Node24/npm、原 DSH_HOME、目标 profile 与旧来源；备份登记和日志库并保留旧来源。使用新的长期目录，PlanOnly 通过且完整退出相关宿主后安装，按 Harmony → Verify 构建并用正式 CLI 登记。desktop/web 各自处理，同环境冷启动。保留其它插件、模型、凭据、草稿、对话、验证记录和日志，不复制另一台电脑的 Data，不删除既有日志来验收升级。分别报告构建、登记、运行和设备待验项，失败按指南回退。

## 本次改变与数据兼容

上一版为 `v0.5.0-rc.9-e2e-0.5.0-rc.2`。本次默认会话日志，开发验证收在更多工具；「AI」改「加入对话」并简化草稿；日志直接永久删除副本；扩容导入并重做Notepad++式跨文件查找。安装标识 `dsh-e2e`、存储 `dshE2E`、API 路径、日志协议 2 保持不变，不需要搬迁数据。

普通日志列表、正文、下载、导出、跨文件筛选仍限当前会话。management 专用入口只提供跨会话摘要与明确选定的永久删除操作；不删除对话、验证/采集记录、截图录像、未归属旧日志和用户原文件。手动媒体继续跨会话保留。

前版已移除第三方 E2E 框架；使用 `save_task/begin_validation/record_checkpoint/finish_validation` 等当前接口，旧 `run/replay/retry` 已退役，不用于当前验收。

导入容量提升为明文1GiB、压缩包2GiB、累计展开8GiB、10000条目。压缩体积与展开体积独立，60MB压缩包仍可能展开超过8GiB。上限边界已测试，未实际执行满1/2/8GiB载荷。前版原厂视频静止页冷启动、转屏/USB 拔插等待验边界没有因日志补丁消失。

## 1. 在目标电脑确认现状

1. 明确选择本次 RC，不使用 `/releases/latest` 推断预发布版本；记录来源 SHA/ZIP hash。
2. 查实际 EXE/CLI、真正 Node24/npm、运行进程的 profile 参数和数据目录。当前终端的 DSH_HOME、端口和 package 版本不能单独证明正在运行的环境。
3. 分别对使用的 desktop/web 执行 `node scripts/verify-install.mjs '<原DataHome>\profiles\<profile>'`，记录版本、来源与 bundle。不打印密钥、令牌或完整会话。
4. 所有路径以目标电脑为准。不要复制旧电脑 Data、profile、模型配置、登录状态、签名、设备序列号、SDK；在目标电脑发现其 HDC/hilogtool。

## 2. 下载与校验

下载这两个同名资产，不能用旧 hash 验新包：

- `dsh-harmony-0.5.0-rc.10-e2e-0.5.0-rc.3-windows-source.zip`
- `dsh-harmony-0.5.0-rc.10-e2e-0.5.0-rc.3-windows-source.zip.sha256`

在下载目录执行：

```powershell
$upgradeArchive = Join-Path (Get-Location) 'dsh-harmony-0.5.0-rc.10-e2e-0.5.0-rc.3-windows-source.zip'
$upgradeExpectedHash = ((Get-Content -LiteralPath ($upgradeArchive + '.sha256') -Raw).Trim() -split '\s+')[0]
if ($upgradeExpectedHash -notmatch '^[a-fA-F0-9]{64}$' -or
    (Get-FileHash -LiteralPath $upgradeArchive -Algorithm SHA256).Hash -ne $upgradeExpectedHash) {
  throw 'Release checksum mismatch'
}
```

解压到**新的长期来源目录**，不要覆盖运行中的 link 来源；进入含 README、plugin、scripts、docs 的内层根目录。发行源码不含 node_modules，需要联网安装依赖，不是离线即装包。`release-manifest.json` 校验原始源码，不能改写来绕过预检。

## 3. 完整退出、备份与预检

保存草稿、结束录像/设备任务，完整退出所有引用旧来源的 desktop/web 宿主。关闭窗口、刷新网页不代表完整退出。用户已经授权升级时不重复询问同一权限；不能正常退出则报告具体阻塞。

保留旧来源/运行产物、两个 profile 的 package/lock/composition/兼容配置，并备份原 DataHome 日志库（含 sessions/trash、旧共享日志和索引）及需要保护的验证记录。备份留在目标电脑。安装脚本自动备份 profile 配置，**不会替用户备份整个日志库**。不 reset/clean/stash 未知工作树，不删除旧来源。

在新来源根目录填写目标电脑实际路径：

```powershell
$upgradeDshExe = '实际的\DeepSeek Harness.exe'
$upgradeDataHome = '已确认的原DSH数据目录'
$upgradeNode = '实际的Node24\node.exe'
$upgradeNpm = '实际的\npm\bin\npm-cli.js'
.\scripts\install.ps1 -DshExe $upgradeDshExe -DataHome $upgradeDataHome `
  -DshProfile desktop -NodeExe $upgradeNode -NpmCli $upgradeNpm -PlanOnly
```

非标准布局可用 `-DshCli '实际的\dsh.cmd'` 替换 DshExe。PlanOnly 不安装、不构建、不写 profile；核对宿主精确版本、Node24、包版本、manifest、原生资源与 `pairedSources: 28`。失败先纠正来源/路径，不改兼容限制。

## 4. 安装与双 profile 登记

去掉同一命令的 `-PlanOnly` 正式安装。脚本按所选 Node24 安装锁定依赖、构建 Harmony → Verify；两包成功后才通过正式 CLI 登记并增量补齐 bundle，最后 verify-install。任一步非零立即停止，保留退出码与备份位置。

若使用 web，再用 `-DshProfile web -PlanOnly` 核对后单独正式安装；desktop 成功不能推断 web 已升级。**两次安装完成前保持相关宿主退出**，避免第二次构建覆盖正在运行的共享来源。未使用的 profile 不必新建。

使用原 DataHome 冷启动：

```powershell
.\scripts\start-desktop.ps1 -DshExe $upgradeDshExe `
  -DataHome $upgradeDataHome -E2ENode $upgradeNode
# 若使用 web，另用实际 CLI、原端口等原参数启动，不另建数据目录：
# .\scripts\start-web.ps1 -DshCli '实际的\dsh.cmd' -DataHome $upgradeDataHome -NodeExe $upgradeNode
```

不要落到默认 C 盘 `.dsh`，不要通过运行中刷新配出新前端/旧后端。无需安装 skill、Pixso MCP 或升级 DSH 宿主。

## 5. 分层验收

- **登记与运行**：verify-install 的版本/来源/bundle 正确，冷启动无 fatal load failure；使用的 desktop/web 分别报告。工具名出现不能代替行为证据。
- **原内容与布局**：草稿、原对话和日志保留；会话日志填满剩余高度；当前会话正文/跨文件筛选与隔离保留。
- **统一管理**：列出有日志或旧版删除残留的会话，检查名称/ID 搜索、估算占用、分页和多选。没有可选标题服务时退回 ID，不启动模型或读取消息正文生成名称。
- **清理交互**：删除直接永久移除插件副本，没有回收入口、输入确认或撤销。单份与统一管理都检查选择范围；升级不会自动清理旧回收内容。升级验收不点击删除用户既有日志，执行测试只用隔离的可丢弃副本。
- **范围与部分失败**：一次最多200会话/10000文件；服务端在该次请求内冻结具体文件集合并消费一次性令牌，后来新增文件不加入本次删除。导入/解析中会话跳过并逐项提示，部分失败不能报告全部成功。
- **跨文件交互**：当前会话多文件普通/扩展/正则查找，计数区分行数与出现次数；F4/Shift+F4、Enter/双击定位、完整复制、完整条件历史和短屏布局。JavaScript/Boost语法差异、30秒、长行/跨行/复制预算见日志指南，不声明与Notepad++完全等同。
- **设备与 AI**：离线阅读不需要手机/模型；HDC、投屏、10 万行性能、批注附件与验证控制释放另行按授权验收。缺设备不能用模拟数据冒充真实通过。

## 6. 失败恢复与回退

构建失败且未登记时原 profile 保留。部分登记失败时保持宿主退出，通过同一 CLI 将两个插件分别 `plugin --profile <profile> add <旧来源绝对目录>`，增量核对原 bundle/composition；不覆盖其它插件或整个 profile。已使用的 desktop/web 分别恢复，再同数据目录冷启动。

回退不复制整个旧Data覆盖升级后新增内容。rc.9/Verify rc.2可读取相同会话存储与旧回收记录，但无法恢复新版已经永久删除的副本。删除前需要保留内容时应先下载原文件或备份；回退插件不是数据恢复。更早 JSONL 版本不理解 blocks-v1，需要对应备份或重新导入原文，不能宣称只回退插件即兼容全部数据。

记录失败阶段、退出码、来源、备份与回退实际结果，不公开认证 URL、日志、媒体或配置。404/旧界面先查来源/profile与完整重启，不删 Data；401/403 正常认证，不关闭门禁。

## 7. 交付记录

报告目标 tag/提交、ZIP hash、宿主/Node、原 DataHome/profile、实际来源和备份位置；分别列出构建、登记、冷启动、UI、设备 Completed/Pending/Rollback。本机验收、同机独立目录构建与另一台实体电脑升级是三类证据，未实际执行不能写完成。

# 安装与AI升级：0.6.0-rc.1

两个插件配套升级，适用 Windows x64、DSH 0.2.0-rc.2、Node.js 24。本版为RC预发布。[固定版本下载](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.6.0-rc.1) · [自审验收与未验范围](LOG_ANALYSIS_SELF_REVIEW_20261105.md) · [日志使用指南](LOG_WORKBENCH.md)

## 版本与数据

| 项目 | 本版 |
|---|---|
| 设备插件安装名 | `dsh-harmony`，`0.6.0-rc.1` |
| 日志插件安装名 | `dsh-log-analysis`，`0.6.0-rc.1` |
| 日志源码目录 | `plugin/dsh-e2e`，沿用历史目录名 |
| 日志数据目录 | 原 `DSH_HOME/storages/dshE2E`，不搬迁 |
| 日志入口 | 会话标题栏“日志分析” |
| 日志接口 | `/api/dsh-log-analysis/log-library/*` |

旧 `dsh-e2e` 包登记、验证和AI手机工具入口退役。升级不清空日志、对话、截图、录屏或旧 `validation-v1/workflows` 历史。加入对话只填当前草稿，仍由用户发送。

同一窗口按设备复用投屏，离开后最多保留10分钟，后端无订阅另有15秒detach保留。观看不冷初始化语义驱动；手工指针走HDC。≤16 MiB小录屏有界加载，大录屏保持range播放。未验场景不能按单元测试推定通过。

## 下载、校验与解压

从固定Release下载源码ZIP和同名 `.zip.sha256`，给另一台电脑升级时一起传递：

`dsh-harmony-0.6.0-rc.1-log-analysis-0.6.0-rc.1-windows-source.zip`

下面所有示例路径都必须替换为目标电脑已核实的真实路径，不能照抄开发机的E盘：

```powershell
$archive = 'D:\Downloads\dsh-harmony-0.6.0-rc.1-log-analysis-0.6.0-rc.1-windows-source.zip'
$expected = ((Get-Content -LiteralPath ($archive + '.sha256') -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw '压缩包校验失败，停止升级' }
```

解压到新的独立目录，保留旧来源回滚。ZIP内有一层同名目录，`$source` 应指向包含 `plugin`、`scripts`、`release-manifest.json` 的根。不要覆盖正在运行的 `link:` 来源，不要解压进用户Data。源码包不含依赖和构建产物，安装依赖需要联网。

## 盘点路径和运行环境

```powershell
$source = 'D:\DSH-Plugins\dsh-harmony-0.6.0-rc.1-log-analysis-0.6.0-rc.1-windows-source'
$dshExe = 'D:\DeepSeekHarness\App\DeepSeek Harness.exe'
$dshCli = 'D:\DeepSeekHarness\App\resources\runtime\cli\bin\dsh.cmd'
$dataHome = 'D:\DeepSeekHarness\Data'
$node = 'D:\DeepSeekHarness\App\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$npmCli = 'D:\Nodejs\node_modules\npm\bin\npm-cli.js'
$profileName = 'desktop'  # 网页宿主改为 web；两种都用要各登记一次
$profile = Join-Path $dataHome ('profiles\' + $profileName)
& $node --version
& $node $npmCli --version
& $dshCli --version
& $node (Join-Path $source 'scripts\preflight.mjs') $source $profile
if ($LASTEXITCODE -ne 0) { throw '源码包或目标profile预检失败' }
```

从原启动器、实际进程和profile核实DSH_HOME，不能默认终端的用户目录就是宿主数据目录。Node必须为24，宿主应为0.2.0-rc.2；不自动升级宿主。`npm-cli.js` 通过所选Node执行，不用 `npm.ps1`。

预检应为 `passed`、两包版本 `0.6.0-rc.1`、`releaseChecksums: true`、`pairedSources: 26`。它校验清单内源码SHA256；修改源码后不能继续拿原清单宣称一致。profile必须已初始化，新安装应先用目标DSH_HOME启动一次目标profile再退出，不能临时换空DSH_HOME制造成功。

检查profile自定义cordis配置是否引用 `dsh-e2e` 或 `dsh-harmony/agent`，遇到引用先核对用途，不盲删整份配置。新来源的 `node_modules` 若是指向旧来源的junction，核实后只移除junction本身，再干净安装；不要沿junction递归删除旧依赖。

## 备份并停止宿主

保留旧源码、构建产物和原启动器。每个目标profile分别备份 `package.json`、`pnpm-lock.yaml`、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`compatibility.json`，记录旧来源/版本/日志数量。重要数据可另行备份；升级不移动或删除storages。

完整退出核实过路径的DSH进程；desktop/web共享来源时两边都退出。不要只关窗口就认为已退出，不结束Codex、HDC服务或其它应用。

## 安装脚本

```powershell
& (Join-Path $source 'scripts\install.ps1') -DshCli $dshCli -DshExe $dshExe -DataHome $dataHome -NodeExe $node -NpmCli $npmCli -DshProfile $profileName -PlanOnly
# 核对路径及 Mutates=false 后执行同一组参数的安装：
& (Join-Path $source 'scripts\install.ps1') -DshCli $dshCli -DshExe $dshExe -DataHome $dataHome -NodeExe $node -NpmCli $npmCli -DshProfile $profileName
```

脚本会备份profile、安装依赖、先构建两包，再调用正式DSH命令登记、移除旧包和校验。失败即停止后续步骤，不自动清数据或假定已经回滚。若执行策略不允许运行脚本，不修改全局策略，可使用下面的等价命令。

## 等价手工命令

已备份并退出宿主后执行，每步非零退出码都应停止：

```powershell
$env:DSH_HOME = $dataHome
$env:PATH = (Split-Path $node) + [IO.Path]::PathSeparator + $env:PATH
foreach ($dir in @('plugin\dsh-harmony', 'plugin\dsh-e2e')) {
    $package = Join-Path $source $dir
    & $node $npmCli --prefix $package ci --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
    & $node $npmCli --prefix $package run build
    if ($LASTEXITCODE -ne 0) { throw '构建失败' }
}
& $dshCli plugin --profile $profileName add (Join-Path $source 'plugin\dsh-harmony')
if ($LASTEXITCODE -ne 0) { throw '设备插件登记失败' }
& $dshCli plugin --profile $profileName add (Join-Path $source 'plugin\dsh-e2e')
if ($LASTEXITCODE -ne 0) { throw '日志插件登记失败' }
$installed = Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
if ($installed.dependencies.'dsh-e2e') {
    & $dshCli plugin --profile $profileName remove dsh-e2e
    if ($LASTEXITCODE -ne 0) { throw '旧包登记移除失败' }
}
& $node (Join-Path $source 'scripts\register-bundles.mjs') (Join-Path $profile 'package.json')
if ($LASTEXITCODE -ne 0) { throw 'bundle登记失败' }
& $node (Join-Path $source 'scripts\verify-install.mjs') $profile
if ($LASTEXITCODE -ne 0) { throw '登记验证失败' }
```

目录虽然叫 `dsh-e2e`，实际登记名必须为 `dsh-log-analysis`。pnpm锁由正式CLI维护，不手工拼改。两个插件不再依赖旧preset构建顺序，仍建议按上面的设备、日志顺序执行。

同时使用desktop/web时，换 `$profileName/$profile`，为另一profile备份并重复登记；共享同一已构建来源时不必再次安装源码依赖。保留新来源目录，`link:` 安装仍需要它，不要升级后删除。

## 冷启动与验收

用原启动器和原DSH_HOME完整启动，前后端同版本后再刷新页面。网页可用正式 `dsh web --no-open`，但需继承正确DSH_HOME/Node24环境，不能启动到默认用户目录的另一个profile。

1. `verify-install.mjs` 和带profile的 `preflight.mjs` 都通过。两包名称/版本/解析路径/bundle正确，旧 `dsh-e2e` 不再激活。
2. “日志分析”中旧日志数量和名称正常；文件读取、跨文件查找、源行定位、历史、加入当前草稿和全部会话管理可用。加入对话不自动发送。
3. 已授权手机连接时验证投屏、唤醒自动恢复、A→B→A复用、截图/录屏/批注。异常后先重新观察手机，不盲重试输入。
4. 删除测试只用一次性副本；它永久删除对应插件副本和缓存，不删用户原文件。
5. 分开报告登记、源码测试、界面、真机结果。没有手机时只报离线日志验收，不能冒称投屏通过。

本版已用真实10万行日志、398页跨文件oracle及常规投屏恢复自验。USB拔插、转屏、大录屏range、长期资源及多样本冷启仍有未验边界，不承诺所有冷启动5秒内。

## 回滚

1. 完整退出相关宿主，保持相同DSH_HOME。
2. 使用官方CLI重新 `add` 保留的旧来源 `plugin/dsh-harmony` 和 `plugin/dsh-e2e`，然后 `remove dsh-log-analysis`。旧来源必须是真旧包，不是本版同名历史目录。
3. `plugin remove` 不清bundle列表。从目标 `package.json` 的 `dsh.profile.bundles` 仅移除 `dsh-log-analysis`，保留其它插件、依赖和设置。用旧来源的 `register-bundles.mjs` 恢复旧两包，对照备份检查字段。
4. 用旧来源 `verify-install.mjs` 检查，原启动器冷启动。收起的旧dshVerify标签需重新打开。

不要reset/clean当前来源、删除storages或整份覆盖profile抹掉其它设置。旧版能继续读取旧验证历史，已直接删除的日志不能靠回滚恢复。部分安装失败先盘点登记和解析目录，再选回滚或修复。

## 给AI执行升级

把本指南、固定Release链接及两个校验文件一起交给AI，说明目标电脑路径、profile和可操作范围。明确授权升级时可完成备份、依赖安装、构建、登记和必要重启；只要求计划时保持只读。不输出令牌/Cookie/私人日志，不扩大权限、不改ACL或全局执行策略，不擅自发布。最终回报新旧版本、来源、备份、已验/未验和回滚方法。

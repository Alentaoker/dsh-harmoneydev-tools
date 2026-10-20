# dshHarmony 安装指南

当前配套预发布：dshHarmony 0.5.0-rc.9 + dshVerify 0.5.0-rc.2（安装标识 dsh-e2e），tag `v0.5.0-rc.9-e2e-0.5.0-rc.2`。无需迁移用户数据或重装宿主；[本次运行验收](../../docs/RELEASE_ACCEPTANCE_20261020.md) · [可移植性验证范围](../../docs/PORTABILITY.md)。

本仓库当前版本的两个插件配套安装。要求 Windows、DSH 0.2.0-rc.2、Node 24 和 npm；目标 DSH 数据目录及 desktop/web profile 已初始化。手机功能另需 HDC、驱动和调试授权，离线日志阅读不需要手机。

从公开仓库的明确提交/tag 或源码包取得文件并保留来源目录。在**仓库根目录**执行，替换为实际安装路径：

```powershell
$installDshExe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
$installDataHome = Join-Path $env:USERPROFILE '.dsh'
.\scripts\install.ps1 -DshExe $installDshExe -DataHome $installDataHome -DshProfile desktop -PlanOnly
# 核对预检结果，完整退出目标宿主后安装
.\scripts\install.ps1 -DshExe $installDshExe -DataHome $installDataHome -DshProfile desktop
.\scripts\start-desktop.ps1 -DshExe $installDshExe -DataHome $installDataHome
```

脚本读取 `plugin/dsh-harmony` 与 `plugin/dsh-e2e`，先备份并构建两包，再登记到选定 profile。Node/npm 自动发现不足时显式传 `-NodeExe`、`-NpmCli`；使用 CLI 时传 `-DshCli`。desktop/web 分别安装，不合并用户配置。

此流程不安装 `skill/` 或 Pixso MCP。已有安装由旧 `plugins/` 路径迁移时，先阅读 [仓库迁移](../../docs/REPOSITORY_MIGRATION.md)，保留旧来源并重新登记新路径。

- [共用安装步骤与手动安装](../../docs/INSTALLATION.md)
- [AI 安装与恢复](AI_INSTALLATION.md)
- [插件版本升级说明](../../docs/UPGRADE.md)
- [使用说明](USAGE.md)

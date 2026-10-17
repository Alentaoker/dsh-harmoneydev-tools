# 安装与更新

当前配套插件：dshHarmony 0.5.0-rc.5 / dshE2E 0.4.0-rc.5。支持边界为 Windows x64、DSH 0.2.0-rc.2、真正的 Node.js 24 和 npm。下载的源码包仍需联网获取依赖，不包含用户配置、SDK 或驱动。详细流程见 [AI 安装指南](AI_INSTALLATION.md)，本机独立安装证据见 [可移植性记录](PORTABILITY.md)。

## 准备

1. 从有访问权限的私有 Release 下载精确版本 ZIP 和同名 `.sha256`，校验后解压到长期保留的来源目录。安装后不能直接删除或移动它。
2. 确认实际桌面 EXE、CLI、Node/npm 路径和原数据目录。不要照抄其它电脑的盘符或用户名。
3. 目标 profile 需先由官方宿主初始化。全新桌面安装先在指定 `DSH_HOME` 下启动一次，再正常退出；已有环境直接使用原目录。
4. 结束设备任务、录像，完整退出目标宿主。`desktop` 和 `web` 分别登记，同一数据目录不代表两个 profile 已同步安装。

## 桌面安装

在解压后的仓库根目录运行，替换为自己的路径：

```powershell
$installDshExe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
$installDataHome = Join-Path $env:USERPROFILE '.dsh' # 已确认要使用的数据目录
.\scripts\install.ps1 -DshExe $installDshExe `
  -DataHome $installDataHome -DshProfile desktop -PlanOnly
```

核对输出的宿主版本、Node24、DataHome、profile、插件版本、文件哈希与视频资源。全部正确且宿主已退出后，去掉 `-PlanOnly` 执行同一命令：

```powershell
.\scripts\install.ps1 -DshExe $installDshExe `
  -DataHome $installDataHome -DshProfile desktop
.\scripts\start-desktop.ps1 -DshExe $installDshExe -DataHome $installDataHome
```

Node/npm 自动发现不足时，在两次安装命令中都显式传 `-NodeExe '实际的node.exe'`、`-NpmCli '实际的npm-cli.js'`；启动脚本相应传 `-E2ENode '同一个node.exe'`。不要用 Electron EXE 代替 Node，也不要直接用版本不明的终端 `npm` 构建。安装脚本固定通过所选 Node24 运行 npm，并为构建子进程设置 PATH。

脚本先备份 profile 的包清单、锁、composition 和兼容配置，再分别安装依赖、构建两包；都成功后才通过正式 CLI 添加 Harmony、E2E，增量补齐 bundle 并运行 `verify-install.mjs`。失败立即停止，保留原来源和数据。预检、登记和冷启动分别判断，不能仅凭版本号或 HTTP 200 宣称手机功能通过。

## 网页版

使用同一数据目录的 `web` profile；若它尚未初始化，官方 rc.2 CLI 的帮助命令可创建默认模板后退出：

```powershell
$installDshCli = '实际的\dsh.cmd'
if (-not $installDataHome) { throw 'Set installDataHome to the confirmed data directory first.' }
$env:DSH_HOME = $installDataHome
& $installDshCli web --help
.\scripts\install.ps1 -DshCli $installDshCli -DataHome $installDataHome `
  -DshProfile web -NodeExe '实际的node.exe' -NpmCli '实际的npm-cli.js' -PlanOnly
# 核对后去掉 -PlanOnly 安装，再启动
.\scripts\start-web.ps1 -DshCli $installDshCli `
  -DataHome $installDataHome -NodeExe '实际的node.exe'
```

网页认证由用户正常完成。401/403 只能证明未认证请求被拒绝，不能证明认证后的插件 UI/API 已验收。同一手机的操作权限仍需遵守租约，避免同时运行两个实机任务。

## 首次使用与验证

- **离线日志**：不需手机或模型。导入明文或文本 GZ，检查会话日志列表与时间排序、100/500/1000 条分页、搜索、包名、TAG 和详情。AI 分析先生成草稿，发送才进入模型流程。
- **设备与投屏**：另需本机 HDC、USB 驱动、手机调试授权。`hdc list targets -v` 需显示具体设备 `USB Connected`，`UART Ready` 不算手机在线。在设备设置选择并保存本机 `hdc.exe`，核对路径落盘并在重启后保留。视频扩展内嵌于私有包，无需 DevEco Testing/Java；设备兼容仍需验证。锁屏预览不代表 H.264 流通过。
- **原厂二进制 HiLog**：另需 SDK 的 `hilogtool` 与该批日志的配套字典；普通明文、ZIP、RAR 和文本 GZ 不需要它。缺工具或字典时保留原包，补充后重试。
- **AI/E2E**：配置本机可用模型，给出具体目标和验收条件；检查运行、断言、报告、日志状态与控制释放，不能只看条数。

## 更新与回退

优先把新的已校验源码包放在新来源目录，保留旧来源；退出目标宿主后执行预检、安装和同环境冷启动。不要在宿主运行时覆盖其来源，也不要为了更新删除 `DSH_HOME`。只在某个终端设置变量不会改变已经运行的桌面；应通过提供的启动脚本固定数据目录。

回退通过同一正式 CLI 重新登记旧来源，恢复本次拥有的配置字段并冷启动，保留其它插件与模型。新日志格式回退旧插件前另需日志库备份，详见 [AI 升级与回退](AI_UPGRADE.md)。根安装脚本不安装 `skill/`、Pixso MCP 或升级 DSH 宿主。

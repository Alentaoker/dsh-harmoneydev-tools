# 安装与更新

适配 Windows、Node 24、DSH Desktop 0.2.0-rc.2。开始前先运行一次 DSH，让目标 profile 初始化；退出 DSH 后安装。新版宿主的 API 和预设需要另外验证。

## 手动安装

在仓库根目录运行：

```powershell
npm --prefix plugins/dsh-harmony ci --legacy-peer-deps
npm --prefix plugins/dsh-harmony run build
npm --prefix plugins/dsh-e2e ci --legacy-peer-deps
npm --prefix plugins/dsh-e2e run build

$env:DSH_HOME = 'E:\DeepSeekHarness\Data'
$dshCliPath = 'E:\DeepSeekHarness\App\resources\runtime\cli\bin\dsh.cmd'
& $dshCliPath plugin --profile desktop add (Resolve-Path 'plugins/dsh-harmony').Path
& $dshCliPath plugin --profile desktop add (Resolve-Path 'plugins/dsh-e2e').Path
node scripts/register-bundles.mjs "$env:DSH_HOME/profiles/desktop/package.json"
```

先 Harmony，后 E2E。四种 Agent 预设的兼容补丁基于 rc.2；E2E 的补丁保留 Harmony 的完整预设，再追加自身工具。不要改成只覆盖一个工具的残缺预设。

`scripts/install.ps1` 自动执行上述步骤并备份 profile 的配置、包清单和锁文件。备份在 `$DSH_HOME/backups/dsh-harmony-e2e-<time>`，不复制密钥、完整会话或其他数据。安装中途失败时停止，不继续启动。检查提示并依据备份人工恢复，不删用户数据目录。

默认终端 Node 不是 24 时，显式传入 `-NodeExe` 和 `-NpmCli`（npm 的 `bin/npm-cli.js`）；安装脚本使用指定 Node 运行 npm，并将该 Node 加入子进程路径，退出时恢复当前终端的 PATH 和 DSH_HOME。完整示例及 Agent 验收清单见 [AI 安装指南](AI_INSTALLATION.md)。

## 启动目录

只在某个终端设置环境变量，不会影响此前已运行的桌面进程，也不会永久改变桌面快捷方式。

```powershell
.\scripts\start-desktop.ps1 -DshExe 'E:\DeepSeekHarness\App\DeepSeek Harness.exe' `
  -DataHome 'E:\DeepSeekHarness\Data'
```

把这个启动脚本用作今后的桌面入口，或者让原启动入口显式设置相同 `DSH_HOME`。若默认快捷方式仍打开 C 盘环境，将看到另一套插件和供应商。目录差异不能通过更换端口解决。

E2E 优先使用宿主随附的 Node；安装结构不同时可给启动脚本传 `-E2ENode '完整的node.exe路径'`，它设置 `DSH_E2E_NODE_PATH`。该运行时须为 Node 24。

## 网页版

依次把两个插件安装到 `web` profile 后启动：

```powershell
$env:DSH_HOME = 'E:\DeepSeekHarness\Data'
& $dshCliPath plugin --profile web add (Resolve-Path 'plugins/dsh-harmony').Path
& $dshCliPath plugin --profile web add (Resolve-Path 'plugins/dsh-e2e').Path
node scripts/register-bundles.mjs "$env:DSH_HOME/profiles/web/package.json"
& $dshCliPath web
```

同一手机的控制权只能由一个实例持有。遇到占用时先结束另一实例的操作，不并行运行两个实机测试。

## 首次连接

1. 手机连接 USB、启用调试，在手机上完成授权，保持解锁。
2. DevEco 的 `hdc list targets` 应列出具体在线设备；Windows USB 驱动异常需先修复。
3. DSH 会话顶部打开 dshHarmony，设备设置选择 DevEco SDK 的 `hdc.exe`，刷新。
4. 给会话选择可用模型，打开 dshE2E，要求测试一个具体流程并给出明确验收条件。
5. 测试结束检查“界面结果”和“日志状态”，读取正文，而不是只查看日志条数。

6. 面板默认按会话隔离；旧记录可从“全部会话历史”只读查看。新建和复测按钮生成会话草稿，检查后发送才执行。使用路径见 [工作台指南](PANEL.md)。

## 更新

退出宿主，在同一源码目录执行 `git pull --ff-only`，重新执行安装脚本，再用相同数据目录启动。不要为了更新删除 `$DSH_HOME`；它包含会话、供应商和配置。

本机终端、设备 Shell、签名安装等高级功能还依赖宿主或 SDK 的原生运行时。普通界面操作、截图和 E2E 不要求编译或安装投屏 HAP。


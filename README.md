# dshHarmony + dshE2E

为 **DeepSeek Harness（DSH）** 提供鸿蒙手机操作、设备工作台和有验收条件的端到端测试。两个插件在同一个仓库维护，共用设备管理器和控制权，测试报告及动作缓存保存在本机。

这是社区移植项目，不是 DeepSeek、华为、Piora 或 tester-army 的官方插件。当前适配 **Windows + DSH Desktop 0.2.0-rc.2**；宿主升级后的兼容性需要重新验证。

| 插件 | 当前版本 | 作用 |
|---|---|---|
| **dshHarmony** | 0.3.0 | 插件内置原生 H.264、截图、手机输入和手势、应用与文件管理、日志、设备诊断、语义操作 |
| **dshE2E** | 0.1.2 | 基于真实 `e2e@0.19.0` 执行测试、独立验收、记录证据、复用通过的流程、向 AI 提供应用日志 |

## 可以做什么

- 让 AI 在鸿蒙手机上完成明确任务，例如进入小艺 Work、输入测试请求、检查是否返回预期内容。
- 用确定的控件步骤做回归测试，检查打开页面、输入、提交及返回等行为。
- 保存通过验收的动作缓存，后续尝试回放；回放仍重新定位控件和检查结果，不保证所有任务都能命中缓存。
- 收集目标应用的 HiLog、操作轨迹、耗时、失败原因和关键截图，让外层 AI 据此诊断。
- 配合 DSH 的代码工具形成“测试 → 读日志 → 修改自己的源码 → 编译部署 → 再次测试”。编译、部署和代码修改由开发工具负责，e2e 插件本身不自动构建应用。

第三方应用可以测试和诊断；没有其源码时，不能直接修复其内部实现。首版 E2E 执行器使用控件树，未接入视觉坐标推理；不提供语音、持续按住、密码填写、应用数据清理或云端设备。

## 环境要求

1. Windows 上已安装并运行过 DeepSeek Harness 0.2.0-rc.2，目标 `desktop` 或 `web` profile 已存在。
2. **Node.js 24**、npm 和 Git。安装脚本会安装依赖并在本机构建。
3. 已安装 DevEco Studio/SDK，能找到 `hdc.exe`；手机开启调试并完成设备授权。这个私有自用仓库内置已适配的 ARM64 视频组件，无需安装或运行 DevEco Testing；HDC 和 USB 驱动仍需自行准备。
4. DSH 会话配置了可用模型。E2E 沿用当前会话模型，不需要额外 API Key。视觉模型是 dshHarmony 的可选功能，需要配置支持图片的模型；E2E 首版不依赖它。

## 安装

先退出目标 DSH 实例。以下以安装到 E 盘的 DSH 为例；路径可更换，**数据目录必须与桌面启动时的 `DSH_HOME` 一致**。

```powershell
git clone https://github.com/Alentaoker/dsh-harmony-e2e.git
cd dsh-harmony-e2e

# 只查看安装参数，不修改 profile
.\scripts\install.ps1 -DshCli 'E:\DeepSeekHarness\App\resources\runtime\cli\bin\dsh.cmd' `
  -DataHome 'E:\DeepSeekHarness\Data' -DshProfile desktop -PlanOnly

# 构建两个插件并通过 DSH 插件管理命令安装
.\scripts\install.ps1 -DshCli 'E:\DeepSeekHarness\App\resources\runtime\cli\bin\dsh.cmd' `
  -DataHome 'E:\DeepSeekHarness\Data' -DshProfile desktop

# 显式使用相同数据目录启动桌面版
.\scripts\start-desktop.ps1 -DshExe 'E:\DeepSeekHarness\App\DeepSeek Harness.exe' `
  -DataHome 'E:\DeepSeekHarness\Data'
```

安装脚本先备份目标 profile 的配置和包清单，保留其他插件配置，再依次安装 dshHarmony 和 dshE2E。源码目录是插件的安装来源，安装后不要随意移动；更新时在同一目录拉取、重建、安装并重启宿主。备份用于人工恢复，不会自动回滚部分失败的安装。

也可按 [详细安装指南](docs/INSTALLATION.md) 手动构建和安装。网页版需另外安装到 `web` profile；它与桌面版是不同的 profile。使用同一数据目录也不代表两个 profile 完全相同。

重启后在插件列表查看 **dshHarmony** 和 **dshE2E**，会话顶部也有入口。dshHarmony 设置里选择 DevEco 的 HDC，刷新设备。先确认 HDC 返回在线设备，再检查插件；仅出现串口不代表已连接手机。

## 使用示例

在 DSH 中直接说：

> 用 dshE2E 测试小艺 Work：进入该功能，提交一份三条安排的学习计划，确认本次请求和三条回复都可见。收集对应应用日志，测试后读取正文并说明是否发现与本次任务有关的异常。

用户不需要手查包名。AI 先用 `e2e_phone.resolve_app` 查询设备中的应用；唯一目标可传 `appName`，有多个候选时核实后传 `logAppBundle`。找不到唯一目标会在操作前明确失败，不会默默把日志过滤为空。

`logAppBundle` 只绑定日志目标，**不会重启应用**。`appBundle` 表示显式停止并启动应用，多个入口时还需 `appAbility`。通用界面检查确实不需要应用日志时，可以显式 `collectLogs:false`。

| 工具操作 | 用途 |
|---|---|
| `status` / `resolve_app` | 检查设备和插件，查询真实目标应用 |
| `run` | 执行 `goal + expectation`，或包含断言的确定 `steps` |
| `get_report` / `get_logs` | 查看报告及日志正文，按级别、关键词、分页读取 |
| `list_runs` / `replay` | 查看历史记录，复用已有流程 |
| `cancel` | 取消运行并释放控制权 |

自然语言任务默认最多 12 个动作、每步骤 8 次模型调用、120 秒。重复或无进展会停止。手机同一时间只能执行一个控制任务；桌面端、网页端或其他投屏程序占用时会明确报错。

## 测试后拿到什么

- JSON、Markdown、JUnit 报告和操作轨迹。
- 关键截图、通过/失败证据、耗时、模型调用和缓存记录。
- `app-logs.jsonl` 和报告中的应用日志，默认保留最近 1000 条；截断数量明确记录。
- `run/get_report` 返回最多 20 条关键日志给外层 AI，更多正文通过 `get_logs` 分页读取。手机操作和验收模型仍只看屏幕。

默认数据路径：`$DSH_HOME/storages/dshE2E/workflows/<flow>/runs/<run>`。dshHarmony 配置与资源缓存位于 `$DSH_HOME/storages/dshHarmony`。本机资料、报告、密钥和手机日志不随源码提交到这个仓库。

**UI 验收通过与日志采集成功分别报告。** 0 条不能证明应用没有报错，日志中的 `error` 级别也不必然是应用缺陷。采集前尽量取得设备日志时间水位；取得失败时明确标记可能含缓冲历史日志。普通截图和点击不会中断日志流，设备停止、断开和宿主关闭才取消它。

## 投屏说明

- 从插件 `resources/native-video` 读取经过哈希核对的原生 H.264 扩展，不再访问 DevEco Testing 安装目录或运行 Java。已停止发行和使用旧 HAP 投屏通道。
- 设置中可选择低开销、均衡、流畅三档。默认均衡使用半尺寸、24 fps、约 3 Mbps 的编码参数；这些是请求参数，实际出帧率随屏幕变化和设备而变，不能视作浏览器显示帧率保证。
- 页面隐藏时关闭自身预览，回到前台自动重连；不调用设备全局停止。数据分片有界处理，避免重复拼接复制，静止视频的几何检查降到每 5 秒，实际输入前仍核验几何。
- 静止画面可能先显示明确标记的 JPEG 预览，收到真实视频关键帧后才切换 H.264。预览成功不能当作实时视频成功。
- 已在 API 24 设备观察到真实 H.264；原生组件依赖手机系统库，不能据此保证所有设备、系统版本或模拟器兼容。
- 组件缺失、校验失败或视频不可用时明确报错并使用截图预览，不尝试安装 HAP。锁屏有身份验证时需要用户在手机上解锁。

本仓库现为**私有、自用**。DevEco 原生二进制保留原厂权利，不受本项目 MIT 许可覆盖；没有确认对外分发授权。维护者更新资源可用 `npm --prefix plugins/dsh-harmony run import:video -- --jar '资源包绝对路径'`，固定哈希不匹配时拒绝导入。见 [视频组件分析](docs/NATIVE_VIDEO.md)。

## 验证范围与限制

请看 [测试记录](docs/VALIDATION.md) 和 [故障排查](docs/TROUBLESHOOTING.md)。模拟设备集成测试与真实手机验收分开记录，不将单次成功或自动化测试数量解释成所有功能都已稳定。

当前仍可能遇到页面异步变化导致控件失效。执行器仅对运行器明确证明“目标在派发前离开屏幕”的错误重新观察，最多两次，并重新让模型决策；已发送或效果不确定的动作不会自动重放。模型输出异常、额度不足、设备断开或预算耗尽仍会停止并报告真实原因。

## 开发

```powershell
npm --prefix plugins/dsh-harmony ci --legacy-peer-deps
npm --prefix plugins/dsh-harmony run build
npm --prefix plugins/dsh-harmony test
npm --prefix plugins/dsh-e2e ci --legacy-peer-deps
npm --prefix plugins/dsh-e2e test
```

Harmony 构建和 E2E 构建均使用仓库内的 vendored 来源，不需要这台电脑的原始工程。构建产物不提交；GitHub Actions 在 Windows / Node 24 上构建和执行模拟测试，真机测试需自行连接设备。

目录：`plugins/dsh-harmony` 为 Harmony 移植；`plugins/dsh-e2e` 为 E2E 适配；`scripts` 为安装与启动辅助；`docs` 为使用、验收和排障说明。

## 来源与许可

- dshHarmony 基于 [kexijiang/Piora](https://github.com/kexijiang/Piora)，保留 MIT 许可和固定提交信息，见 `plugins/dsh-harmony/UPSTREAM.json`、`LICENSE-Piora`。
- dshE2E 适配采用 Apache-2.0，依赖 [tester-army/e2e](https://github.com/tester-army/e2e) 0.19.0。见 `plugins/dsh-e2e/LICENSE`。
- 投屏组件的来源、哈希和公开验证记录随资源保留；本机私有签名、开发者凭据及 DevEco 专有二进制不发布。完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


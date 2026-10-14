# dshHarmony + dshE2E

为 **DeepSeek Harness（DSH）** 提供鸿蒙手机操作、设备工作台和有验收条件的端到端测试。两个插件在同一个仓库维护，共用设备管理器和控制权，测试报告及动作缓存保存在本机。

这是社区移植项目，不是 DeepSeek、华为、Piora 或 tester-army 的官方插件。当前适配 **Windows + DSH Desktop 0.2.0-rc.2**；宿主升级后的兼容性需要重新验证。

| 插件 | 当前版本 | 作用 |
|---|---|---|
| **dshHarmony** | 0.4.3 | 原生 H.264、截图录像、手机输入和手势、应用与文件管理、可调布局的实时 HiLog、应用包名过滤与 Ctrl+F、设备诊断、语义操作 |
| **dshE2E** | 0.3.1 | 会话测试、结构化报告、独立离线日志工作台与导入、分页过滤查找、调整复测和通过流程复用；基于 `e2e@0.19.0` |

## 可以做什么

- 让 AI 在鸿蒙手机上完成明确任务，例如进入小艺 Work、输入测试请求、检查是否返回预期内容。
- 用确定的控件步骤做回归测试，检查打开页面、输入、提交及返回等行为。
- 保存通过验收的动作缓存，后续尝试回放；回放仍重新定位控件和检查结果，不保证所有任务都能命中缓存。
- 收集目标应用的 HiLog、操作轨迹、耗时、失败原因和关键截图，让外层 AI 据此诊断。
- 使用 Harmony 实时日志诊断手机，或在 E2E 独立日志工作台导入本机 TXT/LOG/JSONL；支持 TAG/PID/TID/级别、正则、大小写及独立 Ctrl+F，阅读本身不调用模型。[日志使用指南](docs/LOG_WORKBENCH.md)
- 下一轮日志改进的范围、P0/P1 和验收标准见 [日志系统改进规划](docs/LOG_WORKBENCH_IMPROVEMENT_PLAN.md)，其中规划功能尚未实施。
- 在面板按会话、结果和关键词查找测试，打开概览／步骤截图／日志／复测记录；失败后调整参数生成新测试，保留原报告。
- 配合 DSH 的代码工具形成“测试 → 读日志 → 修改自己的源码 → 编译部署 → 再次测试”。编译、部署和代码修改由开发工具负责，e2e 插件本身不自动构建应用。

第三方应用可以测试和诊断；没有其源码时，不能直接修复其内部实现。E2E 操作仍使用控件树；独立视觉验收可向当前会话中已确认支持图像输入的模型发送脱敏截图，不使用视觉坐标操作；不提供语音、持续按住、密码填写、应用数据清理或云端设备。

## 环境要求

1. Windows 上已安装并运行过 DeepSeek Harness 0.2.0-rc.2，目标 `desktop` 或 `web` profile 已存在。
2. **Node.js 24**、npm 和 Git。安装脚本会安装依赖并在本机构建。
3. 操作手机需要可用的 Harmony SDK/HDC、USB 驱动和设备调试授权；无需完整安装 DevEco IDE。这个私有自用仓库内置已适配的 ARM64 视频组件，无需安装或运行 DevEco Testing；HDC 和驱动仍需自行准备。离线日志工作台不需要手机/HDC。
4. AI 测试需要 DSH 会话配置可用模型，沿用当前会话供应商。视觉模型是 Harmony 可选功能；E2E 当前执行不依赖它。实时/离线日志阅读均不调用模型。

## 安装

支持 Windows、DSH **0.2.0-rc.2**、Node 24；目录不限盘符。可使用私有 Release 的 `*-windows-source.zip`（无需 Git）或明确 tag/SHA 的源码。ZIP 是源文件发行包，首次安装仍需联网获取依赖并构建；包含两个插件的 vendored 来源、许可证与视频资源，**不带用户配置、密钥、会话或手机日志**。

下载 ZIP 后用 `Get-FileHash -Algorithm SHA256` 比较 Release 的 `.sha256`，解压到长期保留的目录；预检还会核对每文件哈希。先用目标 `DSH_HOME` 启动一次 DSH，初始化对应 profile，然后完整退出。

在解压/源码根目录执行，路径按实际电脑填写：

```powershell
$installDshExe = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
$installDataHome = Join-Path $env:USERPROFILE '.dsh'

# 只读检查版本、profile、锁文件和发行资源
.\scripts\install.ps1 -DshExe $installDshExe `
  -DataHome $installDataHome -DshProfile desktop -PlanOnly

# 构建两个插件，再使用受支持的 plugin add 登记
.\scripts\install.ps1 -DshExe $installDshExe `
  -DataHome $installDataHome -DshProfile desktop

# 同环境冷启动
.\scripts\start-desktop.ps1 -DshExe $installDshExe -DataHome $installDataHome
```

PowerShell 5.1/7 均可用。优先寻找桌面随附 **Node 24**；发现不足时传 `-DshCli 'dsh.cmd完整路径' -NodeExe 'Node24完整路径' -NpmCli 'npm-cli.js完整路径'`。系统 Node 20 不会被悄悄用于构建。`PlanOnly` 不构建、不安装、不写 profile；实际安装先备份，两包构建成功才登记，部分失败不自动回滚。

来源目录被 profile 引用，安装后不要移动或删除。升级可在新目录先验证，再登记新来源，保留旧目录用于恢复。数据目录必须与以后的启动入口相同；脚本不永久修改系统环境或原快捷方式。

网页版另安装到 `web` profile，再用同数据目录启动；desktop/web 独立，不保证供应商和插件相同。启动辅助见 `scripts/start-web.ps1`。HDC/USB 驱动仍是外部依赖；**无需 DevEco Testing、Java 或本机 Piora 工程**。原生视频是 ARM64 手机组件，系统兼容需实测；缺失资源可用截图，损坏资源预检停止。

准确顺序、AI 检查清单、冷启动/实机验收、恢复见 [AI 可执行安装指南](docs/AI_INSTALLATION.md)。手动安装见 [详细指南](docs/INSTALLATION.md)，升级见 [升级说明](docs/UPGRADE.md)。在插件列表与会话顶部确认两入口，再验证设备、操作和日志；仅看到面板不代表安装全部通过。

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
| `list_runs` / `replay` / `retry` | 当前会话分页历史、复用通过流程、覆盖参数调整复测并关联原报告 |
| `cancel` | 取消运行并释放控制权 |

自然语言任务默认每步骤最多 30 个动作、20 次模型调用、任务 300 秒。重复或无进展会停止。手机同一时间只能执行一个控制任务；桌面端、网页端或其他投屏程序占用时会明确报错。

## 操作入口与验收范围

同时安装两个插件时，含结果检查的手机任务默认必须走 e2e_phone.run。status/resolve_app 只是查询。Harmony 观察仍可用于识别当前页面；直接 prepare/tap/input/run_scenario 必须明确选择 execution:"direct" 并填写 directReason，返回注明未创建 E2E 测试。运行中的 E2E 禁止插入直控动作。单独安装 Harmony 时保留原入口。

E2E 会安全交接当前会话的空闲直控租约，更新令牌和页面引用；不会抢占其他会话、手动控制或录像。

- runMode:"workflow" 从本次操作开始留证；runMode:"verify_current" 只验当前页面，不执行 goal、不重启或重发，不追认此前操作。两种模式均要求 goal；自然语言模式另需 expectation。
- verificationMode:"semantic" 只按控件树验收；verificationMode:"visual" 对实际截图内容做独立验收，需当前模型明确支持 image，失败不自动降级、不换供应商。视觉模式关闭动作缓存，保存实际送入模型的验收截图。图中是不是猫应使用 visual，Image 节点存在只能证明结构。
- 应用查询推荐 query；name/appName 为兼容别名，多字段内容冲突会报错。Harmony 等待使用 waitMs，milliseconds 等未知字段在派发前报错。

## 测试工作台

会话顶部打开 dshE2E，默认只显示该会话记录。通过、未通过、进行中、取消和中断可分类查询，支持搜索、每页 20 条和归档恢复；主动选择“全部会话历史”可只读查看其他会话的旧记录。

报告有概览、步骤与截图、应用日志、复测记录四页。日志可按最低级别、关键词和正文分页读取；事件可按采集时间关联日志。新测试尽量保存开始前／结束后的截图，敏感字段坐标不完整或尺寸不匹配时明确不保存。

“新建测试”和“调整后复测”都先生成**当前会话草稿**，检查后发送给 AI 执行，不会点击按钮就直接操作手机。复测生成新记录并关联原报告；原报告保留。确定步骤须在高级设置中同步修改，不能只改目标文字。

面板隐藏暂停刷新，报告和日志按需加载。冷启动遗留的运行显示为中断。桌面更新必须完整退出旧宿主后启动，前端刷新不能保证后端更新。完整使用说明和当前未实现项见 [面板指南](docs/PANEL.md)。

## 测试后拿到什么

- JSON、Markdown、JUnit 报告和操作轨迹。
- 关键截图、通过/失败证据、耗时、模型调用和缓存记录。
- `app-logs.jsonl` 持续分批落盘，默认每次测试最多 32 MiB；内存只保留最近 1000 条且最多 2 MiB 的尾部，完整已落盘日志按需分页读取，省略数量明确记录。
- `run/get_report` 返回最多 20 条关键日志给外层 AI，更多正文通过 `get_logs` 分页读取。手机操作和验收模型仍只看屏幕。

默认数据路径：`$DSH_HOME/storages/dshE2E/workflows/<flow>/runs/<run>`。dshHarmony 配置与资源缓存位于 `$DSH_HOME/storages/dshHarmony`。本机资料、报告、密钥和手机日志不随源码提交到这个仓库。

**UI 验收通过与日志采集成功分别报告。** 0 条不能证明应用没有报错，日志中的 `error` 级别也不必然是应用缺陷。采集前尽量取得设备日志时间水位；取得失败时明确标记可能含缓冲历史日志。普通截图和点击不会中断日志流，设备停止、断开和宿主关闭才取消它。

## 投屏说明

- 从插件 `resources/native-video` 读取经过哈希核对的原生 H.264 扩展，不再访问 DevEco Testing 安装目录或运行 Java。已停止发行和使用旧 HAP 投屏通道。
- 设置中可选择低开销、均衡、流畅三档。默认均衡使用半尺寸、24 fps、约 3 Mbps 的编码参数；这些是请求参数，实际出帧率随屏幕变化和设备而变，不能视作浏览器显示帧率保证。
- 页面隐藏时关闭自身预览，回到前台自动重连；不调用设备全局停止。数据分片有界处理，避免重复拼接复制，静止视频的几何检查降到每 5 秒，实际输入前仍核验几何。
- 同一设备只运行一个原生编码器，经本机共享通道供多个窗口、桌面／网页宿主进程及录像订阅。关闭一个观看者不会中断其他观看者，最后退出才清理编码器和转发。静止画面的新观看者接收配置、关键帧及完整后续帧；慢观看者超出缓存上限时单独断开。
- 视频观看共享，手机输入仍受独立控制租约约束。共享源使用首个连接的质量档位，所有观看者退出后下一次连接才应用其他档位；每个观看窗口仍需要自己的解码和显示开销。承载视频源的宿主进程退出会使其他观看者短暂断流并重连，尚未做到独立常驻视频服务。
- 静止画面可能先显示明确标记的 JPEG 预览，收到真实视频关键帧后才切换 H.264。预览成功不能当作实时视频成功。
- 已在 API 24 设备观察到真实 H.264；原生组件依赖手机系统库，不能据此保证所有设备、系统版本或模拟器兼容。
- 组件缺失、校验失败或视频不可用时明确报错并使用截图预览，不尝试安装 HAP。锁屏有身份验证时需要用户在手机上解锁。

本仓库现为**私有、自用**。DevEco 原生二进制保留原厂权利，不受本项目 MIT 许可覆盖；没有确认对外分发授权。维护者更新资源可用 `npm --prefix plugins/dsh-harmony run import:video -- --jar '资源包绝对路径'`，固定哈希不匹配时拒绝导入。见 [视频组件分析](docs/NATIVE_VIDEO.md)。

## 验证范围与限制

请看 [测试记录](docs/VALIDATION.md) 和 [故障排查](docs/TROUBLESHOOTING.md)。模拟设备集成测试与真实手机验收分开记录，不将单次成功或自动化测试数量解释成所有功能都已稳定。

本次日志 P0 已通过 Harmony 68 项、E2E 29 项及辅助脚本 2 项自动化回归，并完成桌面端实时日志/布局和浏览器实际导入链路验收；具体范围与未验项目见 [验证记录](docs/VALIDATION.md)。

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
- 投屏组件来源、哈希和验证记录随资源保留；原厂组件只在此私有自用仓库内保存，本机签名和开发者凭据不提交。完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


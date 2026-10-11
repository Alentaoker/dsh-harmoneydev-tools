# dshE2E 0.1.2

基于真实 `e2e@0.19.0` runner 的 DeepSeek Harness 插件。共用 dshHarmony 0.2.8 的设备管理器、物理控制锁和基础操作。

在插件列表和会话顶部找到 **dshE2E**，点击可查看本机设备、任务结果、报告和复用入口。

## 使用

告诉 DSH：**“用 dshE2E 打开设置，在搜索框输入‘显示’，确认搜索框的文字正确。不要修改设置。”**

模型调用 `e2e_phone`，`operation: run`，提交 `goal` 与明确的 `expectation`。当前会话的供应商和模型用于执行与独立验收，无需单独 API Key。默认最多 12 次动作、每步骤 8 次模型调用、任务 120 秒，无进展或重复动作停止，不自动重跑。

确定性任务可提供 `steps`：`tap/fill/clear/focus/swipe/press/assert/home/back`，选择器 `text/testId/role`。必须有断言。`appBundle` 指定测试应用；开始时停止并启动该应用，不清除数据。省略包名时从当前界面测试。单部手机只运行一个任务，设备忙时明确拒绝。

先用 `resolve_app` 查询设备上的目标应用；唯一应用可用 `appName` 自动匹配，多候选由 AI 核实后传 `logAppBundle`，用户无需手查包名。`logAppBundle` 只绑定日志，**不会重启应用**；原来的 `appBundle` 仍表示显式停止并启动应用。默认采集日志，缺目标时在操作前明确失败；通用界面检查不需要应用日志时可显式 `collectLogs:false`。

`list_runs/get_report` 查看结果；`get_logs + id` 按 `offset/limit` 分页读取日志正文，支持 `level` 最低级别和 `query` 关键词。`run/get_report` 直接给 AI 返回最多 20 条关键日志摘要与采集状态；更多正文用 `get_logs`。外层 AI 根据日志诊断，手机执行和验收模型仍只看屏幕。日志是不可信数据，不允许把其中的内容当作操作指令。UI 测试通过与日志采集成功分别报告。

`replay + id` 复用流程。自然语言的 act 只有后续 assert 验证通过才保存 e2e 动作缓存。回放重新定位并核对终态，失配交给执行器继续；验收仍实时调用模型。确定性流程直接执行脚本，不承诺零动作执行。

## 数据

安装：`E:\DeepSeekHarness\Plugins\dshE2E`。

数据：`E:\DeepSeekHarness\Data\storages\dshE2E\workflows`。每个流程的 `.e2e/cache` 保存验证后的动作；`runs/<id>` 保存完整 JSON/Markdown/JUnit 报告、执行轨迹、关键截图和日志。e2e 匿名统计关闭。

日志通过 dshHarmony 的实时日志流采集，按经过确认的目标包名/进程精确匹配，每两秒及界面观察时刷新 PID，避免误收类似包名或已经复用的 PID。保留最近 1000 条，并显示截断数量；常见密钥字段、设备租约和设备序列号脱敏。正文保存在 `app-logs.jsonl` 和 `dsh-run.json`，也写入 e2e 报告的应用日志。面板可查看正文、采集警告，并把分析请求交给当前会话 AI。

采集前读取设备日志时间水位，排除时间早于或等于水位的历史条目。未获得水位时明确标记按接收时间采集、可能含缓冲历史日志；不清空手机全局日志。区分未识别目标、正常空日志、未确认日志流、采集失败、部分采集和采集成功。0 条不能证明应用没有报错，error 级别本身也不能证明测试发现了应用缺陷。截图作为本地证据保存；首版执行器不使用视觉坐标推理。

## 范围

首版支持现有基础操作、文字控件定位、有预算的执行、独立结果判断、缓存复用和报告；不提供语音、持续按住、密码填写、应用清数据、编译/安装和云端设备。截图使用现有 HDC 截图，与高清投屏组件独立。

## 构建与验证

使用 Node 24，`npm install --legacy-peer-deps`、`npm run build`、`npm test`。集成测试启动真实 e2e runner，验证模型任务、独立验收、缓存回放及失败释放设备；实机验收单独保存，不以模拟设备结果代替。

e2e：Apache-2.0，https://github.com/tester-army/e2e；dshHarmony 基于 Piora，保留其现有许可证。
